package worldmap

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"sort"
	"strconv"
)

// Floor plans: every piece a player built (it carries a creator that is not
// 0), with its plan-view footprint, for drawing bases at close zoom. Ships
// and carts move and are left out, as are world and dungeon pieces (no
// creator). Nothing here names a player.

// rawPiece is one built piece as a chunk holds it.
type rawPiece struct {
	hash    int32
	x, y, z float32
	// yaw is the heading in half degrees, 0..719.
	yaw    uint16
	tilted bool
}

// rotation decodes a ZDO rotation (ZPackage.WriteSmallRotation): Unity Euler
// angles in half degrees. Two bytes (bit 15 set) carry only the yaw; four
// bytes pack x | y<<10 | z<<20, high word first. Absent means identity.
//
// The yaw returned is the plan-view heading of the piece's local x axis, in
// half degrees clockwise seen from above (Unity's left-handed frame, +z
// north): local +x points along (cos yaw, -sin yaw) in world (x, z). For an
// upright piece that is the Euler y angle. tilted is set when the piece's
// up axis leans more than 10 degrees off vertical; pieces built in vanilla
// only turn about the vertical, so it is rare.
func rotation(has bool, w [2]uint16) (yaw uint16, tilted bool) {
	if !has {
		return 0, false
	}
	if w[0]&0x8000 != 0 {
		return uint16(int(w[0]&0x7fff) % 720), false
	}
	v := uint32(w[0])<<16 | uint32(w[1])
	if v&0x3ff == 0 && (v>>20)&0x3ff == 0 {
		return uint16(int((v>>10)&0x3ff) % 720), false
	}
	rad := func(half uint32) float64 { return float64(half) * 0.5 * math.Pi / 180 }
	ax, ay, az := rad(v&0x3ff), rad((v>>10)&0x3ff), rad((v>>20)&0x3ff)
	sx, cx := math.Sincos(ax)
	sy, cy := math.Sincos(ay)
	sz, cz := math.Sincos(az)
	// Unity's Euler order: R = Ry * Rx * Rz. Local x and z axes in world.
	rx, rz := cy*cz+sy*sx*sz, -sy*cz+cy*sx*sz
	fx, fz := sy*cx, cy*cx
	var deg float64
	if rx*rx+rz*rz >= fx*fx+fz*fz {
		deg = math.Atan2(-rz, rx) * 180 / math.Pi
	} else {
		deg = math.Atan2(fx, fz) * 180 / math.Pi
	}
	half := int(math.Round(deg*2)) % 720
	if half < 0 {
		half += 720
	}
	return uint16(half), cx*cz < math.Cos(10*math.Pi/180)
}

// Piece kinds, coarse enough to style a floor plan.
const (
	PieceWall      = "wall"
	PieceFloor     = "floor"
	PieceRoof      = "roof"
	PieceDoor      = "door"
	PieceStair     = "stair"
	PieceBeam      = "beam"
	PiecePole      = "pole"
	PieceFence     = "fence"
	PieceStation   = "station"
	PieceFurniture = "furniture"
	PieceStorage   = "storage"
	PieceLight     = "light"
	PiecePortal    = "portal"
	PiecePlant     = "plant"
	PieceOther     = "other"
)

// footprint is a piece's plan-view rectangle in its own frame: w along its
// local x axis, d along its local z axis, in metres, centred on the piece's
// position. slope is the pitch of a roof in degrees (0 for anything flat or
// upright), so a plan can hatch roofs differently.
type footprint struct {
	kind  string
	w, d  float32
	slope uint8
}

// unknownFootprint is what a prefab missing from the table gets, so nothing
// a player built disappears from the plan.
var unknownFootprint = footprint{PieceOther, 1, 1, 0}

// Plan-view sizes of the vanilla build pieces, from the 2 m building grid
// and checked against how pieces snap together in a played world: walls and
// floors are 2 m (half and 1x1 pieces 1 m), stairs 2 x 2 rising 1 m, roof
// tiles 2 m along the ridge with a run of 2 m at 26 and 45 degrees and 1 m
// at 67 (rises of 1, 2 and 2 m), sloped beams the same run along their
// length. Roofs and stairs climb towards their local -z. Thicknesses are the
// visible ones (wood about 0.25 m, core wood 0.5 m, stone 1 m).
var footprints = map[string]footprint{
	// Wood.
	"woodwall":                     {PieceWall, 2, 0.25, 0},
	"wood_wall_half":               {PieceWall, 2, 0.25, 0},
	"wood_wall_quarter":            {PieceWall, 1, 0.25, 0},
	"wood_wall_roof":               {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_a":             {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_upsidedown":    {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_45":            {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_45_upsidedown": {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_67_a":          {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_67_upsidedown": {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_top":           {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_top_45":        {PieceWall, 2, 0.25, 0},
	"wood_wall_roof_top_67":        {PieceWall, 2, 0.25, 0},
	"wood_window":                  {PieceWall, 1, 0.25, 0},
	"wood_floor":                   {PieceFloor, 2, 2, 0},
	"wood_floor_1x1":               {PieceFloor, 1, 1, 0},
	"wood_ledge":                   {PieceFloor, 2, 1, 0},
	"wood_roof":                    {PieceRoof, 2, 2, 26},
	"wood_roof_top":                {PieceRoof, 2, 2, 26},
	"wood_roof_icorner":            {PieceRoof, 2, 2, 26},
	"wood_roof_ocorner":            {PieceRoof, 2, 2, 26},
	"wood_roof_45":                 {PieceRoof, 2, 2, 45},
	"wood_roof_top_45":             {PieceRoof, 2, 2, 45},
	"wood_roof_icorner_45":         {PieceRoof, 2, 2, 45},
	"wood_roof_ocorner_45":         {PieceRoof, 2, 2, 45},
	"wood_roof_67":                 {PieceRoof, 2, 1, 67},
	"wood_roof_top_67":             {PieceRoof, 2, 1, 67},
	"wood_roof_icorner_67":         {PieceRoof, 2, 2, 67},
	"wood_roof_ocorner_67":         {PieceRoof, 2, 2, 67},
	"wood_stair":                   {PieceStair, 2, 2, 0},
	"wood_stepladder":              {PieceStair, 1, 2, 0},
	"wood_beam":                    {PieceBeam, 2, 0.25, 0},
	"wood_beam_1":                  {PieceBeam, 1, 0.25, 0},
	"wood_beam_26":                 {PieceBeam, 2, 0.25, 26},
	"wood_beam_45":                 {PieceBeam, 2, 0.25, 45},
	"wood_beam_67":                 {PieceBeam, 1, 0.25, 67},
	"wood_pole":                    {PiecePole, 0.25, 0.25, 0},
	"wood_pole2":                   {PiecePole, 0.25, 0.25, 0},
	"wood_door":                    {PieceDoor, 2, 0.25, 0},
	"wood_gate":                    {PieceDoor, 4, 0.25, 0},
	"wood_fence":                   {PieceFence, 2, 0.2, 0},
	"wood_fence_gate":              {PieceDoor, 2, 0.2, 0},
	"stake_wall":                   {PieceFence, 2, 0.5, 0},
	"piece_sharpstakes":            {PieceFence, 2, 1.5, 0},
	"wood_dragon1":                 {PieceFurniture, 2, 1, 0},

	// Core wood.
	"wood_wall_log":        {PieceWall, 2, 0.5, 0},
	"wood_wall_log_4x0.5":  {PieceWall, 4, 0.5, 0},
	"wood_pole_log":        {PiecePole, 0.5, 0.5, 0},
	"wood_pole_log_4":      {PiecePole, 0.5, 0.5, 0},
	"wood_pole_log_4_worn": {PiecePole, 0.5, 0.5, 0},
	"wood_log_26":          {PieceBeam, 2, 0.5, 26},
	"wood_log_45":          {PieceBeam, 2, 0.5, 45},
	"wood_log_67":          {PieceBeam, 1, 0.5, 67},

	// Turf roofs.
	"turf_roof":      {PieceRoof, 2, 2, 26},
	"turf_roof_top":  {PieceRoof, 2, 2, 26},
	"turf_roof_wall": {PieceWall, 2, 0.25, 0},

	// Stone.
	"stone_wall_1x1":  {PieceWall, 1, 1, 0},
	"stone_wall_2x1":  {PieceWall, 2, 1, 0},
	"stone_wall_4x2":  {PieceWall, 4, 1, 0},
	"stone_floor":     {PieceFloor, 4, 4, 0},
	"stone_floor_2x2": {PieceFloor, 2, 2, 0},
	"stone_arch":      {PieceWall, 2, 1, 0},
	"stone_pillar":    {PiecePole, 1, 1, 0},
	"stone_stair":     {PieceStair, 2, 2, 0},
	"stone_fence":     {PieceFence, 2, 0.5, 0},

	// Iron.
	"iron_grate":          {PieceDoor, 2, 0.2, 0},
	"iron_wall_1x1":       {PieceWall, 1, 0.25, 0},
	"iron_wall_1x1_rusty": {PieceWall, 1, 0.25, 0},
	"iron_wall_2x2":       {PieceWall, 2, 0.25, 0},
	"iron_floor_1x1":      {PieceFloor, 1, 1, 0},
	"iron_floor_1x1_v2":   {PieceFloor, 1, 1, 0},
	"iron_floor_2x2":      {PieceFloor, 2, 2, 0},
	"woodiron_beam":       {PieceBeam, 2, 0.25, 0},
	"woodiron_beam_26":    {PieceBeam, 2, 0.25, 26},
	"woodiron_beam_45":    {PieceBeam, 2, 0.25, 45},
	"woodiron_beam_67":    {PieceBeam, 1, 0.25, 67},
	"woodiron_pole":       {PiecePole, 0.25, 0.25, 0},

	// Darkwood.
	"darkwood_beam":            {PieceBeam, 2, 0.3, 0},
	"darkwood_beam4x4":         {PieceBeam, 4, 0.3, 0},
	"darkwood_beam_26":         {PieceBeam, 2, 0.3, 26},
	"darkwood_beam_45":         {PieceBeam, 2, 0.3, 45},
	"darkwood_beam_67":         {PieceBeam, 1, 0.3, 67},
	"darkwood_pole":            {PiecePole, 0.3, 0.3, 0},
	"darkwood_pole4":           {PiecePole, 0.3, 0.3, 0},
	"darkwood_arch":            {PieceWall, 2, 0.3, 0},
	"darkwood_decowall":        {PieceWall, 2, 0.25, 0},
	"darkwood_gate":            {PieceDoor, 4, 0.3, 0},
	"darkwood_raven":           {PieceFurniture, 1, 1, 0},
	"darkwood_wolf":            {PieceFurniture, 1, 1, 0},
	"darkwood_roof":            {PieceRoof, 2, 2, 26},
	"darkwood_roof_top":        {PieceRoof, 2, 2, 26},
	"darkwood_roof_icorner":    {PieceRoof, 2, 2, 26},
	"darkwood_roof_ocorner":    {PieceRoof, 2, 2, 26},
	"darkwood_roof_45":         {PieceRoof, 2, 2, 45},
	"darkwood_roof_top_45":     {PieceRoof, 2, 2, 45},
	"darkwood_roof_icorner_45": {PieceRoof, 2, 2, 45},
	"darkwood_roof_ocorner_45": {PieceRoof, 2, 2, 45},
	"darkwood_roof_67":         {PieceRoof, 2, 1, 67},
	"darkwood_roof_top_67":     {PieceRoof, 2, 1, 67},
	"darkwood_roof_icorner_67": {PieceRoof, 2, 2, 67},
	"darkwood_roof_ocorner_67": {PieceRoof, 2, 2, 67},

	// Stave (Deep North).
	"stave_wall_2x2":      {PieceWall, 2, 0.25, 0},
	"stave_deco_wall_2x2": {PieceWall, 2, 0.25, 0},
	"stave_wall_cross_26": {PieceWall, 2, 0.25, 0},
	"stave_wall_cross_45": {PieceWall, 2, 0.25, 0},
	"stave_wall_cross_67": {PieceWall, 2, 0.25, 0},
	"stave_beam_2m":       {PieceBeam, 2, 0.3, 0},
	"stave_beam_4m":       {PieceBeam, 4, 0.3, 0},
	"stave_beam_26":       {PieceBeam, 2, 0.3, 26},
	"stave_beam_45":       {PieceBeam, 2, 0.3, 45},
	"stave_beam_67":       {PieceBeam, 1, 0.3, 67},
	"stave_deco_beam_2m":  {PieceBeam, 2, 0.3, 0},
	"stave_deco_beam_26":  {PieceBeam, 2, 0.3, 26},
	"stave_deco_beam_45":  {PieceBeam, 2, 0.3, 45},
	"stave_deco_beam_67":  {PieceBeam, 1, 0.3, 67},
	"stave_pole_2m":       {PiecePole, 0.3, 0.3, 0},
	"stave_pole_4m":       {PiecePole, 0.3, 0.3, 0},
	"stave_deco_pole_2m":  {PiecePole, 0.3, 0.3, 0},
	"stave_gate":          {PieceDoor, 4, 0.3, 0},

	// Black marble (Mistlands).
	"blackmarble_1x1":                {PieceWall, 1, 1, 0},
	"blackmarble_2x1x1":              {PieceWall, 2, 1, 0},
	"blackmarble_2x2x1":              {PieceWall, 2, 1, 0},
	"blackmarble_2x2x2":              {PieceFloor, 2, 2, 0},
	"blackmarble_floor":              {PieceFloor, 2, 2, 0},
	"blackmarble_tile_floor_1x1":     {PieceFloor, 1, 1, 0},
	"blackmarble_tile_floor_2x2":     {PieceFloor, 2, 2, 0},
	"blackmarble_tile_wall_1x1":      {PieceWall, 1, 0.25, 0},
	"blackmarble_tile_wall_2x2":      {PieceWall, 2, 0.25, 0},
	"blackmarble_tile_wall_2x4":      {PieceWall, 2, 0.25, 0},
	"blackmarble_arch":               {PieceWall, 2, 1, 0},
	"blackmarble_column_1":           {PiecePole, 1, 1, 0},
	"blackmarble_column_2":           {PiecePole, 1, 1, 0},
	"blackmarble_base_1":             {PieceWall, 2, 1, 0},
	"blackmarble_base_2":             {PieceWall, 2, 1, 0},
	"blackmarble_basecorner":         {PieceWall, 1, 1, 0},
	"blackmarble_out_1":              {PieceWall, 2, 1, 0},
	"blackmarble_out_2":              {PieceWall, 2, 1, 0},
	"blackmarble_outcorner":          {PieceWall, 1, 1, 0},
	"blackmarble_stair":              {PieceStair, 2, 2, 0},
	"piece_dvergr_wood_wall":         {PieceWall, 2, 0.25, 0},
	"piece_dvergr_metal_wall_2x2":    {PieceWall, 2, 0.25, 0},
	"piece_dvergr_wood_door":         {PieceDoor, 2, 0.25, 0},
	"piece_dvergr_pole":              {PiecePole, 0.3, 0.3, 0},
	"piece_dvergr_stake_wall":        {PieceFence, 2, 0.5, 0},
	"piece_dvergr_sharpstakes":       {PieceFence, 2, 1.5, 0},
	"piece_dvergr_spiralstair":       {PieceStair, 3, 3, 0},
	"piece_dvergr_spiralstair_right": {PieceStair, 3, 3, 0},
	"piece_hexagonal_door":           {PieceDoor, 2, 0.25, 0},
	"crystal_wall_1x1":               {PieceWall, 1, 0.25, 0},

	// Ashwood and grausten (Ashlands).
	"ashwood_wall_2x2":                           {PieceWall, 2, 0.25, 0},
	"ashwood_halfwall_1x2":                       {PieceWall, 2, 0.25, 0},
	"ashwood_quarterwall_1x1":                    {PieceWall, 1, 0.25, 0},
	"ashwood_decowall_2x2":                       {PieceWall, 2, 0.25, 0},
	"ashwood_decowall_divider":                   {PieceWall, 2, 0.25, 0},
	"ashwood_decowall_tree":                      {PieceWall, 2, 0.25, 0},
	"ashwood_wall_arch":                          {PieceWall, 2, 0.25, 0},
	"ashwood_wall_beam_26":                       {PieceWall, 2, 0.25, 0},
	"ashwood_wall_beam_26_alt":                   {PieceWall, 2, 0.25, 0},
	"ashwood_wall_beam_45":                       {PieceWall, 2, 0.25, 0},
	"ashwood_wall_beam_45_alt":                   {PieceWall, 2, 0.25, 0},
	"ashwood_wall_beam_67":                       {PieceWall, 2, 0.25, 0},
	"ashwood_wall_cross_26":                      {PieceWall, 2, 0.25, 0},
	"ashwood_wall_cross_26_alt":                  {PieceWall, 2, 0.25, 0},
	"ashwood_wall_cross_45":                      {PieceWall, 2, 0.25, 0},
	"ashwood_wall_cross_45_alt":                  {PieceWall, 2, 0.25, 0},
	"ashwood_wall_cross_67":                      {PieceWall, 2, 0.25, 0},
	"ashwood_wall_roof_26":                       {PieceWall, 2, 0.25, 0},
	"ashwood_wall_roof_26_upsidedown":            {PieceWall, 2, 0.25, 0},
	"ashwood_wall_roof_45":                       {PieceWall, 2, 0.25, 0},
	"ashwood_wall_roof_45_upsidedown":            {PieceWall, 2, 0.25, 0},
	"ashwood_wall_roof_67_a":                     {PieceWall, 2, 0.25, 0},
	"ashwood_wall_roof_67_upsidedown":            {PieceWall, 2, 0.25, 0},
	"ashwood_floor_1x1":                          {PieceFloor, 1, 1, 0},
	"ashwood_floor_2x2":                          {PieceFloor, 2, 2, 0},
	"ashwood_deco_floor":                         {PieceFloor, 2, 2, 0},
	"ashwood_beam_1m":                            {PieceBeam, 1, 0.25, 0},
	"ashwood_beam_2m":                            {PieceBeam, 2, 0.25, 0},
	"ashwood_pole_1m":                            {PiecePole, 0.25, 0.25, 0},
	"ashwood_pole_2m":                            {PiecePole, 0.25, 0.25, 0},
	"ashwood_arch_big":                           {PieceWall, 4, 0.5, 0},
	"ashwood_arch_bottom":                        {PieceWall, 2, 0.5, 0},
	"ashwood_arch_top":                           {PieceWall, 2, 0.5, 0},
	"ashwood_stair":                              {PieceStair, 2, 2, 0},
	"ashwood_door":                               {PieceDoor, 2, 0.25, 0},
	"flametal_gate":                              {PieceDoor, 4, 0.3, 0},
	"Piece_flametal_beam":                        {PieceBeam, 2, 0.3, 0},
	"Piece_flametal_pillar":                      {PiecePole, 0.5, 0.5, 0},
	"Piece_grausten_wall_1x2":                    {PieceWall, 1, 1, 0},
	"Piece_grausten_wall_2x2":                    {PieceWall, 2, 1, 0},
	"Piece_grausten_wall_4x2":                    {PieceWall, 4, 1, 0},
	"Piece_grausten_wall_arch":                   {PieceWall, 2, 1, 0},
	"Piece_grausten_wall_arch_inverted":          {PieceWall, 2, 1, 0},
	"Piece_grausten_window_2x2":                  {PieceWall, 2, 1, 0},
	"Piece_grausten_window_4x2":                  {PieceWall, 4, 1, 0},
	"Piece_grausten_floor_1x1":                   {PieceFloor, 1, 1, 0},
	"Piece_grausten_floor_2x2":                   {PieceFloor, 2, 2, 0},
	"Piece_grausten_floor_4x4":                   {PieceFloor, 4, 4, 0},
	"Piece_grausten_pillar_arch":                 {PieceWall, 2, 1, 0},
	"Piece_grausten_pillar_arch_small":           {PieceWall, 1, 1, 0},
	"Piece_grausten_pillarbase_medium":           {PiecePole, 1, 1, 0},
	"Piece_grausten_pillarbase_small":            {PiecePole, 0.5, 0.5, 0},
	"Piece_grausten_pillarbase_tapered":          {PiecePole, 1, 1, 0},
	"Piece_grausten_pillarbase_tapered_inverted": {PiecePole, 1, 1, 0},
	"Piece_grausten_pillarbeam_medium":           {PieceBeam, 2, 1, 0},
	"Piece_grausten_pillarbeam_small":            {PieceBeam, 2, 0.5, 0},
	"piece_grausten_roof_45":                     {PieceRoof, 2, 2, 45},
	"piece_grausten_roof_45_arch":                {PieceRoof, 2, 2, 45},
	"piece_grausten_roof_45_arch_corner":         {PieceRoof, 2, 2, 45},
	"piece_grausten_roof_45_arch_corner2":        {PieceRoof, 2, 2, 45},
	"piece_grausten_roof_45_corner":              {PieceRoof, 2, 2, 45},
	"piece_grausten_roof_45_corner2":             {PieceRoof, 2, 2, 45},
	"piece_grausten_stonestair":                  {PieceStair, 2, 2, 0},
	"Piece_grausten_stone_ladder":                {PieceStair, 1, 0.5, 0},
	"Ashland_Stair":                              {PieceStair, 2, 2, 0},
	"Ashland_Steepstair":                         {PieceStair, 2, 2, 0},
	"piece_stakewall_blackwood":                  {PieceFence, 2, 0.5, 0},
	"piece_drawbridge":                           {PieceDoor, 4, 0.5, 0},
	"piece_drawbridge_log":                       {PieceDoor, 4, 0.5, 0},
	"siege_wall_1x1":                             {PieceWall, 1, 1, 0},

	// Crafting stations and their extensions.
	"piece_workbench":               {PieceStation, 2, 1, 0},
	"piece_workbench_ext1":          {PieceStation, 1, 0.5, 0},
	"piece_workbench_ext2":          {PieceStation, 1.5, 0.7, 0},
	"piece_workbench_ext3":          {PieceStation, 1, 0.5, 0},
	"piece_workbench_ext4":          {PieceStation, 1.5, 1, 0},
	"forge":                         {PieceStation, 2, 1.5, 0},
	"forge_ext1":                    {PieceStation, 1, 1, 0},
	"forge_ext2":                    {PieceStation, 1, 1, 0},
	"forge_ext3":                    {PieceStation, 1, 1, 0},
	"forge_ext4":                    {PieceStation, 1, 1, 0},
	"forge_ext5":                    {PieceStation, 1, 1, 0},
	"forge_ext6":                    {PieceStation, 1, 1, 0},
	"piece_stonecutter":             {PieceStation, 2, 1, 0},
	"piece_artisanstation":          {PieceStation, 2, 1.5, 0},
	"artisan_ext1":                  {PieceStation, 1, 1, 0},
	"blackforge":                    {PieceStation, 2, 1.5, 0},
	"blackforge_ext1":               {PieceStation, 1, 1, 0},
	"blackforge_ext2_vise":          {PieceStation, 1, 1, 0},
	"blackforge_ext3_metalcutter":   {PieceStation, 1, 1, 0},
	"blackforge_ext4_gemcutter":     {PieceStation, 1, 1, 0},
	"blackforge_ext5_apron":         {PieceStation, 1, 1, 0},
	"piece_magetable":               {PieceStation, 2, 1, 0},
	"piece_magetable_ext":           {PieceStation, 1, 1, 0},
	"piece_magetable_ext2":          {PieceStation, 1, 1, 0},
	"piece_magetable_ext3":          {PieceStation, 1, 1, 0},
	"piece_magetable_ext4":          {PieceStation, 1, 1, 0},
	"piece_cauldron":                {PieceStation, 1.5, 1.5, 0},
	"cauldron_ext1_spice":           {PieceStation, 1, 0.5, 0},
	"cauldron_ext3_butchertable":    {PieceStation, 1.5, 1, 0},
	"cauldron_ext4_pots":            {PieceStation, 1, 1, 0},
	"cauldron_ext5_mortarandpestle": {PieceStation, 0.5, 0.5, 0},
	"cauldron_ext6_rollingpins":     {PieceStation, 0.5, 0.5, 0},
	"cauldron_ext7_smoker":          {PieceStation, 1, 1, 0},
	"piece_MeadCauldron":            {PieceStation, 1.5, 1.5, 0},
	"piece_preptable":               {PieceStation, 2, 1, 0},
	"piece_cookingstation":          {PieceStation, 2, 0.5, 0},
	"piece_cookingstation_iron":     {PieceStation, 2, 0.5, 0},
	"piece_oven":                    {PieceStation, 2, 2, 0},
	"fermenter":                     {PieceStation, 1.5, 1.5, 0},
	"smelter":                       {PieceStation, 2, 2, 0},
	"blastfurnace":                  {PieceStation, 2, 2, 0},
	"charcoal_kiln":                 {PieceStation, 2, 2, 0},
	"windmill":                      {PieceStation, 3, 3, 0},
	"piece_spinningwheel":           {PieceStation, 2, 1.5, 0},
	"eitrrefinery":                  {PieceStation, 3, 3, 0},
	"piece_sapcollector":            {PieceStation, 1, 1, 0},
	"piece_beehive":                 {PieceStation, 1, 1, 0},
	"piece_FrostFoundry":            {PieceStation, 2, 2, 0},
	"piece_FrostKiln":               {PieceStation, 2, 2, 0},
	"incinerator":                   {PieceStation, 3, 3, 0},
	"piece_cartographytable":        {PieceStation, 2, 1.5, 0},
	"piece_barber":                  {PieceStation, 1, 1, 0},
	"UpgradeStation":                {PieceStation, 2, 2, 0},
	"guard_stone":                   {PieceStation, 1, 1, 0},
	"piece_shieldgenerator":         {PieceStation, 2, 2, 0},
	"piece_turret":                  {PieceStation, 2, 2, 0},
	"piece_trap_troll":              {PieceStation, 2, 2, 0},
	"piece_TrainingDummy":           {PieceFurniture, 1, 1, 0},
	"piece_ArcheryTarget":           {PieceFurniture, 1, 0.5, 0},

	// Fires and lights.
	"fire_pit":                   {PieceLight, 2, 2, 0},
	"fire_pit_iron":              {PieceLight, 2, 2, 0},
	"bonfire":                    {PieceLight, 3, 3, 0},
	"hearth":                     {PieceLight, 3, 2, 0},
	"piece_walltorch":            {PieceLight, 0.5, 0.5, 0},
	"piece_groundtorch":          {PieceLight, 0.5, 0.5, 0},
	"piece_groundtorch_wood":     {PieceLight, 0.5, 0.5, 0},
	"piece_groundtorch_green":    {PieceLight, 0.5, 0.5, 0},
	"piece_groundtorch_blue":     {PieceLight, 0.5, 0.5, 0},
	"piece_groundtorch_mist":     {PieceLight, 0.5, 0.5, 0},
	"piece_brazierfloor01":       {PieceLight, 1, 1, 0},
	"piece_brazierfloor02":       {PieceLight, 1, 1, 0},
	"piece_brazierceiling01":     {PieceLight, 1, 1, 0},
	"piece_dvergr_lantern":       {PieceLight, 0.5, 0.5, 0},
	"piece_dvergr_lantern_pole":  {PieceLight, 0.5, 0.5, 0},
	"piece_hoodedlantern":        {PieceLight, 0.5, 0.5, 0},
	"piece_snowlantern":          {PieceLight, 0.5, 0.5, 0},
	"piece_Lavalantern":          {PieceLight, 0.5, 0.5, 0},
	"piece_jackoturnip":          {PieceLight, 0.5, 0.5, 0},
	"piece_EternalPyre":          {PieceLight, 2, 2, 0},
	"Candle_resin":               {PieceLight, 0.25, 0.25, 0},
	"Candle_resin_bogwitch":      {PieceLight, 0.25, 0.25, 0},
	"MountainKit_brazier_purple": {PieceLight, 1, 1, 0},

	// Storage.
	"piece_chest_wood":       {PieceStorage, 0.6, 0.9, 0},
	"piece_chest":            {PieceStorage, 0.9, 1.5, 0},
	"piece_chest_private":    {PieceStorage, 0.6, 0.9, 0},
	"piece_chest_barrel":     {PieceStorage, 1, 1, 0},
	"piece_chest_blackmetal": {PieceStorage, 1, 1.6, 0},
	"piece_chest_grausten":   {PieceStorage, 1, 1.6, 0},
	"piece_chest_treasure":   {PieceStorage, 0.6, 0.9, 0},
	"piece_chest_warderobe":  {PieceStorage, 0.8, 1.6, 0},
	"wood_stack":             {PieceStorage, 2, 1, 0},
	"wood_fine_stack":        {PieceStorage, 2, 1, 0},
	"wood_core_stack":        {PieceStorage, 2, 1, 0},
	"wood_yggdrasil_stack":   {PieceStorage, 2, 1, 0},
	"wood_frost_stack":       {PieceStorage, 2, 1, 0},
	"blackwood_stack":        {PieceStorage, 2, 1, 0},
	"stone_pile":             {PieceStorage, 2, 2, 0},
	"grausten_pile":          {PieceStorage, 2, 2, 0},
	"coal_pile":              {PieceStorage, 2, 2, 0},
	"flint_pile":             {PieceStorage, 2, 2, 0},
	"blackmarble_pile":       {PieceStorage, 2, 2, 0},
	"obsidian_pile":          {PieceStorage, 2, 2, 0},
	"bone_stack":             {PieceStorage, 2, 2, 0},
	"skull_pile":             {PieceStorage, 2, 2, 0},
	"morgenhole_pile":        {PieceStorage, 2, 2, 0},
	"treasure_pile":          {PieceStorage, 1, 1, 0},
	"treasure_stack":         {PieceStorage, 1, 1, 0},
	"bar_copper_stack":       {PieceStorage, 1, 1, 0},
	"bar_tin_stack":          {PieceStorage, 1, 1, 0},
	"bar_bronze_stack":       {PieceStorage, 1, 1, 0},
	"bar_iron_stack":         {PieceStorage, 1, 1, 0},
	"bar_silver_stack":       {PieceStorage, 1, 1, 0},
	"bar_blackmetal_stack":   {PieceStorage, 1, 1, 0},
	"bar_flametal_stack":     {PieceStorage, 1, 1, 0},
	"bar_gold_stack":         {PieceStorage, 1, 1, 0},
	"bar_ancientmetal_stack": {PieceStorage, 1, 1, 0},

	// Furniture.
	"bed":                            {PieceFurniture, 1, 2, 0},
	"piece_bed02":                    {PieceFurniture, 2, 2.5, 0},
	"ashwood_bed":                    {PieceFurniture, 2, 2.5, 0},
	"piece_chair":                    {PieceFurniture, 0.5, 0.5, 0},
	"piece_chair02":                  {PieceFurniture, 1, 1, 0},
	"piece_chair03":                  {PieceFurniture, 1, 1, 0},
	"piece_chair_runed":              {PieceFurniture, 1, 1, 0},
	"piece_bench01":                  {PieceFurniture, 2, 0.5, 0},
	"piece_bench_runed":              {PieceFurniture, 2, 0.5, 0},
	"piece_logbench01":               {PieceFurniture, 2, 0.5, 0},
	"piece_blackwood_bench":          {PieceFurniture, 2, 0.5, 0},
	"piece_blackwood_bench01":        {PieceFurniture, 2, 0.5, 0},
	"piece_blackmarble_bench":        {PieceFurniture, 2, 0.5, 0},
	"piece_table":                    {PieceFurniture, 2, 1, 0},
	"piece_table_oak":                {PieceFurniture, 3, 1.5, 0},
	"piece_table_round":              {PieceFurniture, 2, 2, 0},
	"piece_table_runed":              {PieceFurniture, 3, 1.5, 0},
	"piece_table_runed_small":        {PieceFurniture, 2, 1, 0},
	"piece_blackmarble_table":        {PieceFurniture, 2, 1, 0},
	"piece_throne01":                 {PieceFurniture, 1.5, 1.5, 0},
	"piece_throne02":                 {PieceFurniture, 1.5, 1.5, 0},
	"piece_blackmarble_throne":       {PieceFurniture, 1.5, 1.5, 0},
	"piece_bone_throne":              {PieceFurniture, 1.5, 1.5, 0},
	"piece_moose_throne":             {PieceFurniture, 1.5, 1.5, 0},
	"piece_bathtub":                  {PieceFurniture, 3, 3, 0},
	"itemstand":                      {PieceFurniture, 0.5, 0.25, 0},
	"itemstandh":                     {PieceFurniture, 1, 0.5, 0},
	"ArmorStand":                     {PieceFurniture, 1, 1, 0},
	"ArmorStand_Female":              {PieceFurniture, 1, 1, 0},
	"ArmorStand_Male":                {PieceFurniture, 1, 1, 0},
	"sign":                           {PieceFurniture, 1, 0.1, 0},
	"sign_notext":                    {PieceFurniture, 1, 0.1, 0},
	"rug_deer":                       {PieceFurniture, 2, 1.5, 0},
	"rug_wolf":                       {PieceFurniture, 2, 1.5, 0},
	"rug_fur":                        {PieceFurniture, 2, 1.5, 0},
	"rug_hare":                       {PieceFurniture, 1, 1, 0},
	"rug_moose":                      {PieceFurniture, 2, 1.5, 0},
	"rug_seal":                       {PieceFurniture, 2, 1.5, 0},
	"rug_straw":                      {PieceFurniture, 2, 1.5, 0},
	"rug_asksvin":                    {PieceFurniture, 2, 1.5, 0},
	"rug_Bjorn":                      {PieceFurniture, 2, 1.5, 0},
	"jute_carpet":                    {PieceFurniture, 2, 1.5, 0},
	"jute_carpet_blue":               {PieceFurniture, 2, 1.5, 0},
	"piece_cloth_hanging_door":       {PieceDoor, 2, 0.1, 0},
	"piece_cloth_hanging_door_blue":  {PieceDoor, 2, 0.1, 0},
	"piece_cloth_hanging_door_blue2": {PieceDoor, 2, 0.1, 0},

	// Decoration.
	"piece_banner01":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner02":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner03":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner04":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner05":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner06":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner07":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner08":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner09":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner10":           {PieceFurniture, 1, 0.1, 0},
	"piece_banner11":           {PieceFurniture, 1, 0.1, 0},
	"piece_CelebrationGarland": {PieceFurniture, 2, 0.1, 0},
	"piece_FairylightGarland":  {PieceLight, 2, 0.1, 0},
	"piece_xmasgarland":        {PieceFurniture, 2, 0.1, 0},
	"piece_xmastree":           {PieceFurniture, 2, 2, 0},
	"piece_xmascrown":          {PieceFurniture, 1, 1, 0},
	"piece_maypole":            {PieceFurniture, 1, 1, 0},
	"piece_mistletoe":          {PieceFurniture, 0.5, 0.5, 0},
	"piece_gift1":              {PieceFurniture, 0.5, 0.5, 0},
	"piece_gift2":              {PieceFurniture, 0.5, 0.5, 0},
	"piece_gift3":              {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot1":               {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot1_cracked":       {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot1_red":           {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot2":               {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot2_cracked":       {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot2_red":           {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot3":               {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot3_cracked":       {PieceFurniture, 0.5, 0.5, 0},
	"piece_pot3_red":           {PieceFurniture, 0.5, 0.5, 0},
	"ashland_pot1_green":       {PieceFurniture, 0.5, 0.5, 0},
	"ashland_pot1_red":         {PieceFurniture, 0.5, 0.5, 0},
	"ashland_pot2_green":       {PieceFurniture, 0.5, 0.5, 0},
	"ashland_pot2_red":         {PieceFurniture, 0.5, 0.5, 0},
	"ashland_pot3_green":       {PieceFurniture, 0.5, 0.5, 0},
	"ashland_pot3_red":         {PieceFurniture, 0.5, 0.5, 0},
	"piece_birdnest":           {PieceFurniture, 0.5, 0.5, 0},
	"piece_wisplure":           {PieceFurniture, 1, 1, 0},
	"piece_asksvinskeleton":    {PieceFurniture, 2, 1, 0},
	"piece_icecube":            {PieceFurniture, 1, 1, 0},
	"FeastMeadows":             {PieceFurniture, 1, 1, 0},
	"FeastBlackforest":         {PieceFurniture, 1, 1, 0},
	"FeastSwamps":              {PieceFurniture, 1, 1, 0},
	"FeastMountains":           {PieceFurniture, 1, 1, 0},
	"FeastPlains":              {PieceFurniture, 1, 1, 0},
	"FeastMistlands":           {PieceFurniture, 1, 1, 0},
	"FeastAshlands":            {PieceFurniture, 1, 1, 0},
	"FeastDeepNorth":           {PieceFurniture, 1, 1, 0},
	"FeastOceans":              {PieceFurniture, 1, 1, 0},

	// Portals.
	"portal_wood":  {PiecePortal, 3, 1, 0},
	"portal_stone": {PiecePortal, 3, 1, 0},
	"portal":       {PiecePortal, 3, 1, 0},
}

// Planted crops and saplings carry a creator too: a farm reads as a field of
// small squares rather than unknown pieces.
func plantFootprint(name string) (footprint, bool) {
	if len(name) > 8 && name[:8] == "sapling_" {
		return footprint{PiecePlant, 0.5, 0.5, 0}, true
	}
	return footprint{}, false
}

// footprintOf is the table entry for a prefab name, the plant rule, or the
// unknown fallback; ok is false only for the fallback.
func footprintOf(name string) (footprint, bool) {
	if f, ok := footprints[name]; ok {
		return f, true
	}
	if f, ok := plantFootprint(name); ok {
		return f, true
	}
	return unknownFootprint, false
}

// pieceNameByHash names every prefab of the footprint table and the map's
// own list.
var pieceNameByHash = map[int32]string{}

func init() {
	for n := range footprints {
		pieceNameByHash[stableHash(n)] = n
	}
	for n := range prefabNames {
		pieceNameByHash[stableHash(n)] = n
	}
	for _, n := range plantNames {
		pieceNameByHash[stableHash(n)] = n
	}
}

// plantNames are the cultivator's saplings, only for naming them.
var plantNames = []string{
	"sapling_barley", "sapling_carrot", "sapling_flax", "sapling_jotunpuffs", "sapling_Kale",
	"sapling_magecap", "sapling_oat", "sapling_onion", "sapling_poteitr", "sapling_seedcarrot",
	"sapling_seedkale", "sapling_seedonion", "sapling_seedturnip", "sapling_turnip",
}

// pieceName is the prefab name, or "#hash" when the prefab is not known.
func pieceName(hash int32) string {
	if n, ok := pieceNameByHash[hash]; ok {
		return n
	}
	return "#" + strconv.Itoa(int(hash))
}

// MaxPieces caps one /pieces answer.
const MaxPieces = 20000

// piece is one entry of the index, 20 bytes.
type piece struct {
	x, y, z float32
	yaw     uint16 // half degrees
	prefab  uint16 // index into Pieces.prefabs
	tilted  bool
}

type piecePrefab struct {
	name  string
	fp    footprint
	known bool
}

// Pieces is the floor plan index of one snapshot: the built pieces sorted by
// 64 m zone, then bottom to top, with each zone's span. It is read-only once
// built and shared by every request.
type Pieces struct {
	ETag    string
	prefabs []piecePrefab
	pieces  []piece
	zones   map[zoneKey][2]int32
}

// Len is how many pieces the index holds.
func (p *Pieces) Len() int {
	if p == nil {
		return 0
	}
	return len(p.pieces)
}

func buildPieces(chunks []*chunkData) *Pieces {
	n := 0
	for _, c := range chunks {
		n += len(c.built)
	}
	out := &Pieces{pieces: make([]piece, 0, n), zones: map[zoneKey][2]int32{}}
	ids := map[int32]uint16{}
	var hashes []int32
	for _, c := range chunks {
		for _, rp := range c.built {
			id, ok := ids[rp.hash]
			if !ok {
				if len(hashes) == math.MaxUint16 {
					continue
				}
				id = uint16(len(hashes))
				ids[rp.hash] = id
				hashes = append(hashes, rp.hash)
			}
			out.pieces = append(out.pieces, piece{x: rp.x, y: rp.y, z: rp.z, yaw: rp.yaw, prefab: id, tilted: rp.tilted})
		}
	}
	// Prefab ids follow name order so the index does not depend on the
	// order the chunk cache hands chunks out in.
	order := make([]int, len(hashes))
	for i := range order {
		order[i] = i
	}
	names := make([]string, len(hashes))
	for i, h := range hashes {
		names[i] = pieceName(h)
	}
	sort.Slice(order, func(a, b int) bool { return names[order[a]] < names[order[b]] })
	remap := make([]uint16, len(hashes))
	out.prefabs = make([]piecePrefab, len(hashes))
	for newID, oldID := range order {
		remap[oldID] = uint16(newID)
		fp, known := footprintOf(names[oldID])
		out.prefabs[newID] = piecePrefab{name: names[oldID], fp: fp, known: known}
	}
	for i := range out.pieces {
		out.pieces[i].prefab = remap[out.pieces[i].prefab]
	}
	ps := out.pieces
	sort.Slice(ps, func(i, j int) bool {
		a, b := ps[i], ps[j]
		za, zb := zoneOf(a.x, a.z), zoneOf(b.x, b.z)
		if za != zb {
			if za.x != zb.x {
				return za.x < zb.x
			}
			return za.z < zb.z
		}
		if a.y != b.y {
			return a.y < b.y
		}
		if a.x != b.x {
			return a.x < b.x
		}
		if a.z != b.z {
			return a.z < b.z
		}
		if a.prefab != b.prefab {
			return a.prefab < b.prefab
		}
		return a.yaw < b.yaw
	})
	for i := 0; i < len(ps); {
		k := zoneOf(ps[i].x, ps[i].z)
		j := i + 1
		for j < len(ps) && zoneOf(ps[j].x, ps[j].z) == k {
			j++
		}
		out.zones[k] = [2]int32{int32(i), int32(j)}
		i = j
	}
	h := sha256.New()
	for _, p := range out.prefabs {
		h.Write([]byte(p.name))
		h.Write([]byte{0})
	}
	var rec [20]byte
	for _, p := range ps {
		binary.LittleEndian.PutUint32(rec[0:], math.Float32bits(p.x))
		binary.LittleEndian.PutUint32(rec[4:], math.Float32bits(p.y))
		binary.LittleEndian.PutUint32(rec[8:], math.Float32bits(p.z))
		binary.LittleEndian.PutUint16(rec[12:], p.yaw)
		binary.LittleEndian.PutUint16(rec[14:], p.prefab)
		rec[16] = 0
		if p.tilted {
			rec[16] = 1
		}
		h.Write(rec[:17])
	}
	out.ETag = hex.EncodeToString(h.Sum(nil)[:12])
	return out
}

// PieceQuery is the result of Pieces.Query.
type PieceQuery struct {
	X0, Z0, X1, Z1 float64
	Truncated      bool
	prefabs        []int // prefab ids in output order
	pieces         []piece
}

// Count is how many pieces the query returns.
func (q *PieceQuery) Count() int { return len(q.pieces) }

// Query collects the pieces whose position lies inside [x0, x1] x [z0, z1],
// zone by zone in index order, at most max of them.
func (p *Pieces) Query(x0, z0, x1, z1 float64, max int) *PieceQuery {
	q := &PieceQuery{X0: x0, Z0: z0, X1: x1, Z1: z1}
	if p == nil {
		return q
	}
	lo, hi := zoneOf(float32(x0), float32(z0)), zoneOf(float32(x1), float32(z1))
	seen := map[uint16]bool{}
	for zx := lo.x; zx <= hi.x; zx++ {
		for zz := lo.z; zz <= hi.z; zz++ {
			span, ok := p.zones[zoneKey{zx, zz}]
			if !ok {
				continue
			}
			for _, pc := range p.pieces[span[0]:span[1]] {
				x, z := float64(pc.x), float64(pc.z)
				if x < x0 || x > x1 || z < z0 || z > z1 {
					continue
				}
				if len(q.pieces) >= max {
					q.Truncated = true
					return q.finish(seen)
				}
				q.pieces = append(q.pieces, pc)
				seen[pc.prefab] = true
			}
		}
	}
	return q.finish(seen)
}

func (q *PieceQuery) finish(seen map[uint16]bool) *PieceQuery {
	for id := range seen {
		q.prefabs = append(q.prefabs, int(id))
	}
	sort.Ints(q.prefabs)
	return q
}

// AppendJSON writes the query as GET /pieces:
//
//	{"generation":N,"bbox":[x0,z0,x1,z1],
//	 "prefabs":[[name,kind,w,d,slope,known],...],
//	 "pieces":[[prefab,x,z,y,yaw,flags],...],"count":n,"truncated":false}
//
// prefab indexes "prefabs"; positions are metres rounded to 0.05, yaw whole
// degrees 0..359, flags bit 0 a tilted piece.
func (p *Pieces) AppendJSON(b []byte, q *PieceQuery, generation int) []byte {
	num := func(v float64) {
		b = strconv.AppendFloat(b, math.Round(v*20)/20, 'f', -1, 64)
	}
	b = append(b, `{"generation":`...)
	b = strconv.AppendInt(b, int64(generation), 10)
	b = append(b, `,"bbox":[`...)
	for i, v := range []float64{q.X0, q.Z0, q.X1, q.Z1} {
		if i > 0 {
			b = append(b, ',')
		}
		num(v)
	}
	b = append(b, `],"prefabs":[`...)
	local := map[uint16]int{}
	for i, id := range q.prefabs {
		local[uint16(id)] = i
		pp := p.prefabs[id]
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = strconv.AppendQuote(b, pp.name)
		b = append(b, ',')
		b = strconv.AppendQuote(b, pp.fp.kind)
		b = append(b, ',')
		num(float64(pp.fp.w))
		b = append(b, ',')
		num(float64(pp.fp.d))
		b = append(b, ',')
		b = strconv.AppendInt(b, int64(pp.fp.slope), 10)
		b = append(b, ',')
		b = strconv.AppendBool(b, pp.known)
		b = append(b, ']')
	}
	b = append(b, `],"pieces":[`...)
	for i, pc := range q.pieces {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = strconv.AppendInt(b, int64(local[pc.prefab]), 10)
		b = append(b, ',')
		num(float64(pc.x))
		b = append(b, ',')
		num(float64(pc.z))
		b = append(b, ',')
		num(float64(pc.y))
		b = append(b, ',')
		b = strconv.AppendInt(b, int64(math.Round(float64(pc.yaw)/2))%360, 10)
		b = append(b, ',')
		if pc.tilted {
			b = append(b, '1')
		} else {
			b = append(b, '0')
		}
		b = append(b, ']')
	}
	b = append(b, `],"count":`...)
	b = strconv.AppendInt(b, int64(len(q.pieces)), 10)
	b = append(b, `,"truncated":`...)
	b = strconv.AppendBool(b, q.Truncated)
	return append(b, '}')
}
