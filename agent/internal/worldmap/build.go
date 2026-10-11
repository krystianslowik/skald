// Package worldmap builds the dashboard's world map from a Valheim 1.0 save:
// land and water from where the save has objects, the explored area and pins
// of the cartography tables, portals, graves, beds, ships, carts, bases,
// generated locations, terrain edits and what players keep in the chests,
// carts and ships they built. See chunk.go, db2.go and inventory.go for the
// file layouts.
//
// A build reads the newest generation with an `.ok` marker. Chunk files are
// cached by (position, revision, ZDO count) from the `.chunks` index, so a
// rebuild only parses the chunks the game rewrote. A chunk that fails to
// parse keeps its last good contents (or is skipped), and a build that fails
// as a whole keeps the last good snapshot. Nothing here panics on bad data.
package worldmap

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/world"
)

// RebuildEvery is how often Run checks for a new save generation.
const RebuildEvery = 60 * time.Second

const (
	maxChunkFile = 256 << 20
	maxIndex     = 1 << 20
	maxIndexRows = 1 << 16
)

type Options struct {
	// Dir is CONFIG_DIR/worlds_local/<world>; empty disables the map.
	Dir string
	// ShowNames exports owner names, portal tags and pin names (MAP_SHOW_NAMES).
	ShowNames bool
	Logger    *slog.Logger
	Now       func() time.Time
}

// Encoded is a built snapshot, serialised once.
type Encoded struct {
	Snapshot *Snapshot
	// Pieces is the floor plan index (GET /pieces); it is not part of JSON.
	Pieces *Pieces
	// Nature is the nature index (GET /nature); it is not part of JSON.
	Nature     *Nature
	JSON       []byte
	Gzip       []byte
	ETag       string
	Generation int
}

type chunkID struct{ x, z, g byte }

type cacheEntry struct {
	rev, count int32
	data       *chunkData
}

type Builder struct {
	opt Options

	// buildMu serialises builds and guards the chunk cache.
	buildMu sync.Mutex
	cache   map[chunkID]*cacheEntry
	lastDB2 *db2Data

	mu        sync.RWMutex
	cur       *Encoded
	lastBuild float64
}

func New(opt Options) *Builder {
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	return &Builder{opt: opt, cache: map[chunkID]*cacheEntry{}}
}

// Enabled is false when no world is configured.
func (b *Builder) Enabled() bool { return b != nil && b.opt.Dir != "" }

// Current is the last good snapshot, or nil before the first build.
func (b *Builder) Current() *Encoded {
	if b == nil {
		return nil
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.cur
}

// LastBuildSeconds is how long the last completed build took (0 before one).
func (b *Builder) LastBuildSeconds() float64 {
	if b == nil {
		return 0
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.lastBuild
}

// Run refreshes the map now and then every `every` until ctx ends.
func (b *Builder) Run(ctx context.Context, every time.Duration) {
	if !b.Enabled() {
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if _, err := b.Refresh(); err != nil {
			b.opt.Logger.Debug("world map not rebuilt", "reason", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Refresh rebuilds the snapshot when the newest finished save generation
// differs from the one the current snapshot was built from. It reports
// whether a new snapshot was published.
func (b *Builder) Refresh() (bool, error) {
	if !b.Enabled() {
		return false, errors.New("world map disabled")
	}
	b.buildMu.Lock()
	defer b.buildMu.Unlock()
	gen, ok := latestOK(b.opt.Dir)
	if !ok {
		return false, errors.New("no finished save generation")
	}
	if cur := b.Current(); cur != nil && cur.Generation == gen {
		return false, nil
	}
	start := time.Now()
	snap, pieces, nature, err := b.build(gen)
	if err != nil {
		return false, err
	}
	snap.Stats.BuildSeconds = math.Round(time.Since(start).Seconds()*1000) / 1000
	enc, err := encode(snap, gen)
	if err != nil {
		return false, err
	}
	enc.Pieces, enc.Nature = pieces, nature
	b.mu.Lock()
	b.cur = enc
	b.lastBuild = time.Since(start).Seconds()
	b.mu.Unlock()
	b.opt.Logger.Info("world map built", "generation", gen, "seconds", snap.Stats.BuildSeconds,
		"chunksParsed", snap.Stats.ChunksParsed, "chunksFailed", snap.Stats.ChunksFailed, "zdos", snap.Stats.ZDOs)
	return true, nil
}

// latestOK is the highest N with an `_main.N.ok` marker (a finished save).
func latestOK(dir string) (int, bool) {
	matches, _ := filepath.Glob(filepath.Join(dir, "_main.*.ok"))
	best, found := 0, false
	for _, p := range matches {
		mid := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(p), "_main."), ".ok")
		n, err := strconv.Atoi(mid)
		if err != nil || n < 0 {
			continue
		}
		if !found || n > best {
			best, found = n, true
		}
	}
	return best, found
}

type indexRow struct {
	id         chunkID
	rev, count int32
}

// readIndex decodes `_main.N.chunks`:
//
//	u16 version | i32 total ZDOs | i32 n | n x (u8 x, u8 z, u8 g, i32 revision, i32 ZDO count)
//
// The chunk file for a row is "%02x_%02x__%d_%d.chunk" of (z, x, g, revision).
func readIndex(path string) ([]indexRow, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxIndex))
	if err != nil {
		return nil, err
	}
	r := &buf{b: raw}
	r.u16()
	r.i32()
	n := int(r.i32())
	if r.err != nil {
		return nil, r.err
	}
	if n < 0 || n > maxIndexRows {
		return nil, errors.New("worldmap: bad chunk index size")
	}
	rows := make([]indexRow, 0, n)
	for i := 0; i < n; i++ {
		x, z, g := r.u8(), r.u8(), r.u8()
		rev, count := r.i32(), r.i32()
		if r.err != nil {
			return nil, r.err
		}
		rows = append(rows, indexRow{id: chunkID{x, z, g}, rev: rev, count: count})
	}
	return rows, nil
}

func chunkFile(dir string, row indexRow) string {
	return filepath.Join(dir, fmt.Sprintf("%02x_%02x__%d_%d.chunk", row.id.z, row.id.x, row.id.g, row.rev))
}

func readFileCapped(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() > max {
		return nil, errors.New("worldmap: file too large")
	}
	b := make([]byte, fi.Size())
	if _, err := io.ReadFull(f, b); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *Builder) build(gen int) (*Snapshot, *Pieces, *Nature, error) {
	dir := b.opt.Dir
	base := filepath.Join(dir, "_main."+strconv.Itoa(gen))
	rows, err := readIndex(base + ".chunks")
	if err != nil {
		return nil, nil, nil, fmt.Errorf("chunk index: %w", err)
	}
	snap := &Snapshot{}
	seen := make(map[chunkID]bool, len(rows))
	for _, row := range rows {
		seen[row.id] = true
		snap.Stats.Chunks++
		if e := b.cache[row.id]; e != nil && e.rev == row.rev && e.count == row.count {
			continue
		}
		raw, err := readFileCapped(chunkFile(dir, row), maxChunkFile)
		var cd *chunkData
		if err == nil {
			cd, err = parseChunk(raw)
		}
		if err != nil {
			// Keep whatever this chunk held last time; a later save rewrites it.
			snap.Stats.ChunksFailed++
			b.opt.Logger.Warn("world map: chunk skipped", "chunk", filepath.Base(chunkFile(dir, row)), "err", err.Error())
			continue
		}
		snap.Stats.ChunksParsed++
		b.cache[row.id] = &cacheEntry{rev: row.rev, count: row.count, data: cd}
	}
	for id := range b.cache {
		if !seen[id] {
			delete(b.cache, id)
		}
	}

	if d, err := readDB2(base + ".db2"); err == nil {
		b.lastDB2 = d
	} else {
		b.opt.Logger.Warn("world map: locations not read", "err", err.Error())
	}

	snap.Meta = Meta{Generation: gen, GeneratedAt: b.opt.Now().UTC(), ShowNames: b.opt.ShowNames, Day: -1}
	if m, err := world.Read(dir); err == nil {
		snap.Meta.SeedName, snap.Meta.Seed, snap.Meta.WorldGenVersion = m.SeedName, m.Seed, m.WorldGenVersion
		snap.Meta.NetTime, snap.Meta.Day, snap.Meta.SavedAt = m.NetTime, m.Day, m.SavedAt
	}

	chunks := make([]*chunkData, 0, len(b.cache))
	for _, e := range b.cache {
		chunks = append(chunks, e.data)
	}
	found := assemble(snap, chunks, b.lastDB2, b.opt.ShowNames)
	return snap, buildPieces(chunks), buildNature(chunks, found), nil
}

// The land grid covers the playable disc: zones -164..164 on both axes.
const (
	landMin  = -164
	landSize = 329
)

// assemble fills the snapshot from the chunks and the .db2. It returns the
// "found" test that gates locations (inside the explored area or within 64 m
// of a built piece), for the nature index.
func assemble(snap *Snapshot, chunks []*chunkData, db *db2Data, showNames bool) func(x, z float32) bool {
	name := func(s string) string {
		if showNames {
			return s
		}
		return ""
	}
	density := map[zoneKey]int32{}
	pieces := map[zoneKey]*zonePieces{}
	terrain := map[zoneKey]int{}
	var explored []uint64
	var portals []rawPortal
	var stores []rawStore
	for _, c := range chunks {
		snap.Stats.ZDOs += c.zdos
		for k, v := range c.density {
			density[k] += v
		}
		for k, zp := range c.pieces {
			m := pieces[k]
			if m == nil {
				m = &zonePieces{stations: map[string]bool{}}
				pieces[k] = m
			}
			m.count += zp.count
			m.bed = m.bed || zp.bed
			for s := range zp.stations {
				m.stations[s] = true
			}
			for _, s := range zp.samples {
				if len(m.samples) < sampleCap {
					m.samples = append(m.samples, s)
				}
			}
		}
		for k, v := range c.terrain {
			terrain[k] += v
		}
		if c.explored != nil {
			if explored == nil {
				explored = make([]uint64, exploredWords)
			}
			for i, w := range c.explored {
				explored[i] |= w
			}
		}
		snap.Explored.Tables += c.tables
		portals = append(portals, c.portals...)
		for _, t := range c.tombs {
			day := int64(-1)
			if t.ticks > 0 {
				day = int64(math.Floor(float64(t.ticks) / 1e7 / world.DayLengthSec))
			}
			snap.Tombstones = append(snap.Tombstones, Tombstone{X: iround(t.x), Z: iround(t.z), Owner: name(t.owner), Day: day, Items: exportItems(t.items, showNames)})
		}
		for _, bd := range c.beds {
			snap.Beds = append(snap.Beds, Bed{X: iround(bd.x), Z: iround(bd.z), Owner: name(bd.owner)})
		}
		for _, v := range c.vehicles {
			id := ""
			if v.built {
				id = storeID(v.kind, v.x, v.z)
			}
			snap.Vehicles = append(snap.Vehicles, Vehicle{ID: id, Kind: v.kind, X: iround(v.x), Z: iround(v.z)})
		}
		stores = append(stores, c.stores...)
		for _, p := range c.pins {
			snap.Pins = append(snap.Pins, Pin{Type: int(p.typ), Kind: pinKind(p.typ), Name: name(p.name), X: iround(p.x), Z: iround(p.z)})
		}
	}

	// Land: generated zones from the .db2, density from the chunks.
	grid := make([]byte, landSize*landSize)
	set := func(k zoneKey, v byte) {
		gx, gz := int(k.x)-landMin, int(k.z)-landMin
		if gx < 0 || gz < 0 || gx >= landSize || gz >= landSize {
			return
		}
		if grid[gz*landSize+gx] < v {
			grid[gz*landSize+gx] = v
		}
	}
	if db != nil {
		snap.Stats.GeneratedZones = len(db.generated)
		for _, k := range db.generated {
			set(k, 1)
		}
	}
	for k, n := range density {
		set(k, densityLevel(n))
	}
	snap.Land = Land{ZoneSize: 64, Min: landMin, Size: landSize, Data: grid}

	snap.Explored.Size, snap.Explored.MetersPerPixel = exploredSize, exploredMPP
	if explored != nil {
		snap.Explored.Available = true
		snap.Explored.RLE, snap.Explored.Pixels = rle(explored)
	}

	snap.Portals = pairPortals(portals, showNames)
	snap.Storage = exportStorage(stores, snap.Vehicles, showNames)
	snap.Bases = clusterBases(pieces)
	for _, zp := range pieces {
		snap.Stats.Pieces += zp.count
	}
	for k, n := range terrain {
		snap.TerrainEdits = append(snap.TerrainEdits, TerrainEdit{X: int(k.x) * 64, Z: int(k.z) * 64, Cells: n})
	}

	found := func(x, z float32) bool { return isExplored(explored, x, z) || nearPieces(pieces, x, z) }
	if db != nil {
		snap.Stats.LocationsTotal, snap.Stats.LocationsPlaced = db.total, db.placed
		for _, l := range db.locations {
			snap.Locations = append(snap.Locations, Location{
				Kind: l.info.kind, Name: l.info.name, X: iround(l.x), Z: iround(l.z), Placed: l.placed,
				Explored: found(l.x, l.z),
			})
		}
	}
	sortSnapshot(snap)
	return found
}

func storeID(prefab string, x, z float32) string {
	return fmt.Sprintf("%s@%d,%d", prefab, iround(x), iround(z))
}

func storeKind(prefab string) string {
	switch prefabByHash[stableHash(prefab)].role {
	case roleVehicle:
		if prefab == "Cart" {
			return KindCart
		}
		return KindShip
	default:
		return KindChest
	}
}

// exportStorage turns the built containers into Snapshot.Storage, in a
// stable order. Two containers on the same metre get "#n" suffixes, lowest
// first, and the vehicles' ids are renamed to match.
func exportStorage(stores []rawStore, vehicles []Vehicle, showNames bool) []Container {
	sort.Slice(stores, func(i, j int) bool {
		a, b := stores[i], stores[j]
		if ax, bx := iround(a.x), iround(b.x); ax != bx {
			return ax < bx
		}
		if az, bz := iround(a.z), iround(b.z); az != bz {
			return az < bz
		}
		if a.prefab != b.prefab {
			return a.prefab < b.prefab
		}
		// A stack on one spot: "#n" counts up from the bottom.
		return a.y < b.y
	})
	out := make([]Container, 0, len(stores))
	seen := map[string]int{}
	renamed := map[string][]string{}
	for _, s := range stores {
		base := storeID(s.prefab, s.x, s.z)
		id := base
		if n := seen[base]; n > 0 {
			id = fmt.Sprintf("%s#%d", base, n)
		}
		seen[base]++
		renamed[base] = append(renamed[base], id)
		items := exportItems(s.items, showNames)
		w, h := gridOf(s.prefab, s.items)
		out = append(out, Container{
			ID: id, Kind: storeKind(s.prefab), Prefab: s.prefab, X: r05(s.x), Y: r05(s.y), Z: r05(s.z),
			Width: w, Height: h, Items: items, Unreadable: s.unreadable,
		})
	}
	// Vehicles carry the base id; hand out the suffixed ones in order.
	for i := range vehicles {
		base := vehicles[i].ID
		if ids := renamed[base]; base != "" && len(ids) > 0 {
			vehicles[i].ID = ids[0]
			renamed[base] = ids[1:]
		}
	}
	return out
}

// densityLevel maps an object count to 2..255 on a log scale (0 objects is 1).
func densityLevel(n int32) byte {
	if n <= 0 {
		return 1
	}
	v := 2 + math.Log2(float64(n))*24
	if v > 255 {
		return 255
	}
	return byte(v)
}

func iround(v float32) int { return int(math.Round(float64(v))) }

// r05 rounds to 5 cm: fine enough to tell stacked chests that drift a few
// tens of centimetres apart from a row of chests next to each other.
func r05(v float32) float64 { return math.Round(float64(v)*20) / 20 }

// pinKind names Valheim's Minimap.PinType values in the game's enum order.
func pinKind(t int32) string {
	kinds := []string{"fire", "home", "hammer", "point", "cave", "death", "bed", "shout", "none", "boss", "player", "event", "ping", "eventarea"}
	if t >= 0 && int(t) < len(kinds) {
		return kinds[t]
	}
	return "other"
}

func explorePixel(x, z float32) (int, bool) {
	col := int(math.Round(float64(x)/exploredMPP)) + exploredSize/2
	row := int(math.Round(float64(z)/exploredMPP)) + exploredSize/2
	if col < 0 || row < 0 || col >= exploredSize || row >= exploredSize {
		return 0, false
	}
	return row*exploredSize + col, true
}

func isExplored(mask []uint64, x, z float32) bool {
	if mask == nil {
		return false
	}
	i, ok := explorePixel(x, z)
	return ok && mask[i>>6]&(1<<(i&63)) != 0
}

func nearPieces(pieces map[zoneKey]*zonePieces, x, z float32) bool {
	k := zoneOf(x, z)
	for dx := int32(-1); dx <= 1; dx++ {
		for dz := int32(-1); dz <= 1; dz++ {
			zp := pieces[zoneKey{k.x + dx, k.z + dz}]
			if zp == nil {
				continue
			}
			for _, s := range zp.samples {
				ddx, ddz := float64(s[0]-x), float64(s[1]-z)
				if ddx*ddx+ddz*ddz <= 64*64 {
					return true
				}
			}
		}
	}
	return false
}

// rle encodes the mask as alternating run lengths (unexplored first), each a
// LEB128 varint, and counts the explored pixels.
func rle(mask []uint64) ([]byte, int) {
	var out []byte
	put := func(n int) {
		for n >= 0x80 {
			out = append(out, byte(n)|0x80)
			n >>= 7
		}
		out = append(out, byte(n))
	}
	cur, run, pixels := false, 0, 0
	for _, w := range mask {
		switch {
		case w == 0 && !cur, w == ^uint64(0) && cur:
			run += 64
			if cur {
				pixels += 64
			}
			continue
		}
		for bit := 0; bit < 64; bit++ {
			on := w&(1<<bit) != 0
			if on != cur {
				put(run)
				cur, run = on, 0
			}
			run++
			if on {
				pixels++
			}
		}
	}
	put(run)
	return out, pixels
}

// pairPortals pairs portals by their connection hash, then pairs leftovers
// that share a non-empty tag when exactly two of them do.
func pairPortals(raw []rawPortal, showNames bool) []Portal {
	out := make([]Portal, len(raw))
	ids := map[string]int{}
	for i, p := range raw {
		id := fmt.Sprintf("%d,%d", iround(p.x), iround(p.z))
		if n := ids[id]; n > 0 {
			id = fmt.Sprintf("%s#%d", id, n)
		}
		ids[id]++
		tag := ""
		if showNames {
			tag = p.tag
		}
		out[i] = Portal{ID: id, Kind: p.kind, X: iround(p.x), Z: iround(p.z), Tag: tag}
	}
	byConn := map[int32][]int{}
	for i, p := range raw {
		if p.hasConn && p.connHash != 0 {
			byConn[p.connHash] = append(byConn[p.connHash], i)
		}
	}
	for _, idx := range byConn {
		if len(idx) == 2 {
			out[idx[0]].PairedWith, out[idx[1]].PairedWith = out[idx[1]].ID, out[idx[0]].ID
		}
	}
	byTag := map[string][]int{}
	for i, p := range raw {
		if out[i].PairedWith == "" && p.tag != "" {
			byTag[p.tag] = append(byTag[p.tag], i)
		}
	}
	for _, idx := range byTag {
		if len(idx) == 2 {
			out[idx[0]].PairedWith, out[idx[1]].PairedWith = out[idx[1]].ID, out[idx[0]].ID
		}
	}
	return out
}

func clusterBases(pieces map[zoneKey]*zonePieces) []Base {
	seen := map[zoneKey]bool{}
	var out []Base
	keys := make([]zoneKey, 0, len(pieces))
	for k := range pieces {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].x != keys[j].x {
			return keys[i].x < keys[j].x
		}
		return keys[i].z < keys[j].z
	})
	for _, start := range keys {
		if seen[start] {
			continue
		}
		seen[start] = true
		stack := []zoneKey{start}
		var total, zones int
		var sx, sz float64
		bed := false
		stations := map[string]bool{}
		for len(stack) > 0 {
			k := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			zp := pieces[k]
			zones++
			total += zp.count
			sx += float64(k.x) * 64 * float64(zp.count)
			sz += float64(k.z) * 64 * float64(zp.count)
			bed = bed || zp.bed
			for s := range zp.stations {
				stations[s] = true
			}
			for dx := int32(-1); dx <= 1; dx++ {
				for dz := int32(-1); dz <= 1; dz++ {
					n := zoneKey{k.x + dx, k.z + dz}
					if pieces[n] != nil && !seen[n] {
						seen[n] = true
						stack = append(stack, n)
					}
				}
			}
		}
		list := make([]string, 0, len(stations))
		for s := range stations {
			list = append(list, s)
		}
		sort.Strings(list)
		out = append(out, Base{
			X: int(math.Round(sx / float64(total))), Z: int(math.Round(sz / float64(total))),
			Pieces: total, Zones: zones, HasBed: bed, Stations: list,
		})
	}
	return out
}

func sortSnapshot(s *Snapshot) {
	byXZ := func(ax, az, bx, bz int) bool {
		if ax != bx {
			return ax < bx
		}
		return az < bz
	}
	sort.Slice(s.Pins, func(i, j int) bool { return byXZ(s.Pins[i].X, s.Pins[i].Z, s.Pins[j].X, s.Pins[j].Z) })
	sort.Slice(s.Portals, func(i, j int) bool { return s.Portals[i].ID < s.Portals[j].ID })
	sort.Slice(s.Tombstones, func(i, j int) bool {
		return byXZ(s.Tombstones[i].X, s.Tombstones[i].Z, s.Tombstones[j].X, s.Tombstones[j].Z)
	})
	sort.Slice(s.Beds, func(i, j int) bool { return byXZ(s.Beds[i].X, s.Beds[i].Z, s.Beds[j].X, s.Beds[j].Z) })
	sort.Slice(s.Vehicles, func(i, j int) bool {
		return byXZ(s.Vehicles[i].X, s.Vehicles[i].Z, s.Vehicles[j].X, s.Vehicles[j].Z)
	})
	sort.Slice(s.Bases, func(i, j int) bool {
		if s.Bases[i].Pieces != s.Bases[j].Pieces {
			return s.Bases[i].Pieces > s.Bases[j].Pieces
		}
		return byXZ(s.Bases[i].X, s.Bases[i].Z, s.Bases[j].X, s.Bases[j].Z)
	})
	sort.Slice(s.Locations, func(i, j int) bool {
		return byXZ(s.Locations[i].X, s.Locations[i].Z, s.Locations[j].X, s.Locations[j].Z)
	})
	sort.Slice(s.TerrainEdits, func(i, j int) bool {
		return byXZ(s.TerrainEdits[i].X, s.TerrainEdits[i].Z, s.TerrainEdits[j].X, s.TerrainEdits[j].Z)
	})
	// Empty lists render as [] rather than null.
	if s.Pins == nil {
		s.Pins = []Pin{}
	}
	if s.Portals == nil {
		s.Portals = []Portal{}
	}
	if s.Tombstones == nil {
		s.Tombstones = []Tombstone{}
	}
	if s.Beds == nil {
		s.Beds = []Bed{}
	}
	if s.Vehicles == nil {
		s.Vehicles = []Vehicle{}
	}
	if s.Bases == nil {
		s.Bases = []Base{}
	}
	if s.Locations == nil {
		s.Locations = []Location{}
	}
	if s.TerrainEdits == nil {
		s.TerrainEdits = []TerrainEdit{}
	}
	if s.Storage == nil {
		s.Storage = []Container{}
	}
	for i := range s.Tombstones {
		if s.Tombstones[i].Items == nil {
			s.Tombstones[i].Items = []Item{}
		}
	}
	if s.Explored.RLE == nil {
		s.Explored.RLE = []byte{}
	}
}

func encode(s *Snapshot, gen int) (*Encoded, error) {
	j, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	var gz bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&gz, gzip.BestSpeed)
	if _, err := zw.Write(j); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	// The ETag ignores generatedAt and build time so an unchanged world keeps
	// its tag across agent restarts.
	h := sha256.New()
	stable := *s
	stable.Meta.GeneratedAt = time.Time{}
	stable.Stats.BuildSeconds = 0
	stable.Stats.ChunksParsed = 0
	sj, _ := json.Marshal(&stable)
	h.Write(sj)
	return &Encoded{Snapshot: s, JSON: j, Gzip: gz.Bytes(), ETag: `"` + hex.EncodeToString(h.Sum(nil)[:12]) + `"`, Generation: gen}, nil
}
