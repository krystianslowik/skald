package worldmap

// Prefab, location and ZDO key names the map looks for. The save stores
// only GetStableHashCode(name), so these names are hashed once at start-up
// and matched against the hashes in the chunk files and the .db2 location
// list. Only names are listed here (facts about the game), no game data.
//
// Prefab names: https://valheim-modding.github.io/Jotunn/data/prefabs/prefab-list.html
// Location names: https://valheim-modding.github.io/Jotunn/data/zones/location-list.html

// stableHash is Valheim's String.GetStableHashCode: two interleaved djb2-style
// accumulators over the UTF-16 code units, combined with a fixed multiplier.
// Every name here is ASCII, so bytes and UTF-16 code units are the same.
func stableHash(s string) int32 {
	var a, b uint32 = 5381, 5381
	for i := 0; i < len(s); i += 2 {
		a = ((a << 5) + a) ^ uint32(s[i])
		if i == len(s)-1 {
			break
		}
		b = ((b << 5) + b) ^ uint32(s[i+1])
	}
	return int32(a + b*1566083941)
}

// ZDO map keys.
var (
	keyCreator     = stableHash("creator")
	keyTag         = stableHash("tag")
	keyOwnerName   = stableHash("ownerName")
	keyTimeOfDeath = stableHash("timeOfDeath")
	keyData        = stableHash("data")
	keyTCData      = stableHash("TCData")
)

// What a prefab means for the map.
type role uint8

const (
	roleNone role = iota
	rolePortal
	roleTombstone
	roleBed
	roleTable
	roleVehicle
	roleStation
	roleTerrain
)

type prefabInfo struct {
	role role
	// name is the exported kind: the vehicle prefab or the station label.
	name string
}

var prefabNames = map[string]prefabInfo{
	"portal_wood":            {rolePortal, "portal_wood"},
	"portal_stone":           {rolePortal, "portal_stone"},
	"portal":                 {rolePortal, "portal"},
	"Player_tombstone":       {roleTombstone, ""},
	"bed":                    {roleBed, ""},
	"piece_bed02":            {roleBed, ""},
	"piece_cartographytable": {roleTable, ""},
	"_TerrainCompiler":       {roleTerrain, ""},

	"Raft":                {roleVehicle, "Raft"},
	"Karve":               {roleVehicle, "Karve"},
	"VikingShip":          {roleVehicle, "VikingShip"},
	"VikingShip_Ashlands": {roleVehicle, "VikingShip_Ashlands"},
	"Trailership":         {roleVehicle, "Trailership"},
	"Cart":                {roleVehicle, "Cart"},

	"piece_workbench":      {roleStation, "workbench"},
	"forge":                {roleStation, "forge"},
	"piece_stonecutter":    {roleStation, "stonecutter"},
	"piece_artisanstation": {roleStation, "artisan"},
	"blackforge":           {roleStation, "blackforge"},
	"piece_magetable":      {roleStation, "magetable"},
	"piece_cauldron":       {roleStation, "cauldron"},
	"piece_MeadCauldron":   {roleStation, "cauldron"},
	"piece_preptable":      {roleStation, "cauldron"},
	"smelter":              {roleStation, "smelter"},
	"blastfurnace":         {roleStation, "smelter"},
	"charcoal_kiln":        {roleStation, "kiln"},
	"windmill":             {roleStation, "windmill"},
	"piece_spinningwheel":  {roleStation, "spinningwheel"},
	"eitrrefinery":         {roleStation, "eitrrefinery"},
	"fire_pit":             {roleStation, "fire"},
	"fire_pit_iron":        {roleStation, "fire"},
	"bonfire":              {roleStation, "fire"},
	"hearth":               {roleStation, "fire"},
	"guard_stone":          {roleStation, "ward"},
}

// Location kinds the map exports. Every other location is counted in the
// stats but not listed.
const (
	KindStart   = "start"
	KindBoss    = "boss"
	KindTrader  = "trader"
	KindDungeon = "dungeon"
)

var locationNames = map[string]string{
	"StartTemple": KindStart,

	"Eikthyrnir":                    KindBoss,
	"GDKing":                        KindBoss,
	"Bonemass":                      KindBoss,
	"Dragonqueen":                   KindBoss,
	"GoblinKing":                    KindBoss,
	"Mistlands_DvergrBossEntrance1": KindBoss,
	"FaderLocation":                 KindBoss,
	"DN_Bossroom":                   KindBoss,

	"Vendor_BlackForest": KindTrader,
	"Hildir_camp":        KindTrader,
	"BogWitch_Camp":      KindTrader,

	"Crypt2":                        KindDungeon,
	"Crypt3":                        KindDungeon,
	"Crypt4":                        KindDungeon,
	"SunkenCrypt4":                  KindDungeon,
	"TrollCave02":                   KindDungeon,
	"MountainCave02":                KindDungeon,
	"Mistlands_DvergrTownEntrance1": KindDungeon,
	"Mistlands_DvergrTownEntrance2": KindDungeon,
	"Hildir_cave":                   KindDungeon,
	"Hildir_crypt":                  KindDungeon,
	"Hildir_plainsfortress":         KindDungeon,
	"MorgenHole1":                   KindDungeon,
	"MorgenHole2":                   KindDungeon,
	"MorgenHole3":                   KindDungeon,
}

type locationInfo struct {
	name string
	kind string
}

var (
	prefabByHash   = map[int32]prefabInfo{}
	locationByHash = map[int32]locationInfo{}
)

func init() {
	for n, info := range prefabNames {
		prefabByHash[stableHash(n)] = info
	}
	for n, kind := range locationNames {
		locationByHash[stableHash(n)] = locationInfo{name: n, kind: kind}
	}
}
