package worldmap

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fixture is written by `go run ./testdata/gen-world -map testdata/world-map`.
const fixture = "../../testdata/world-map"

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func build(t *testing.T, dir string, names bool) *Builder {
	t.Helper()
	b := New(Options{Dir: dir, ShowNames: names, Logger: quiet})
	if _, err := b.Refresh(); err != nil {
		t.Fatal(err)
	}
	return b
}

func copyDir(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dst
}

func TestStableHash(t *testing.T) {
	// Reference values from the game's GetStableHashCode.
	for name, want := range map[string]int32{
		"creator":          881008290,
		"tag":              696029674,
		"portal_wood":      -661882940,
		"data":             2619694,
		"TCData":           1305470367,
		"ownerName":        1227488406,
		"timeOfDeath":      -35297356,
		"Player_tombstone": -1558312669,
		"StartTemple":      -1544986047,
	} {
		if got := stableHash(name); got != want {
			t.Errorf("stableHash(%q) = %d, want %d", name, got, want)
		}
	}
}

func TestBuildFixture(t *testing.T) {
	s := build(t, fixture, true).Current().Snapshot

	if s.Meta.SeedName != "Yggdrasil1" || s.Meta.Seed != 123456789 || s.Meta.Day != 40 || s.Meta.Generation != 3 || !s.Meta.ShowNames {
		t.Errorf("meta = %+v", s.Meta)
	}
	if s.Stats.Chunks != 4 || s.Stats.ChunksParsed != 4 || s.Stats.ChunksFailed != 0 {
		t.Errorf("stats = %+v", s.Stats)
	}

	// Land: the island zones are land, the generated sea around them is
	// water, and the parked objects at 1e6 m are nowhere.
	land := func(zx, zz int) byte { return s.Land.Data[(zz-s.Land.Min)*s.Land.Size+zx-s.Land.Min] }
	if land(0, 0) < 2 || land(31, 31) < 2 {
		t.Errorf("island zones = %d %d", land(0, 0), land(31, 31))
	}
	if land(7, -7) != 1 {
		t.Errorf("sea zone = %d, want 1", land(7, -7))
	}
	if land(100, 100) != 0 {
		t.Errorf("ungenerated zone = %d, want 0", land(100, 100))
	}
	if s.Stats.GeneratedZones != 17*17+7*7 {
		t.Errorf("generated zones = %d", s.Stats.GeneratedZones)
	}

	if len(s.Portals) != 5 {
		t.Fatalf("portals = %+v", s.Portals)
	}
	pairs := map[string]string{}
	for _, p := range s.Portals {
		pairs[p.ID] = p.PairedWith
	}
	if pairs["96,-180"] != "2020,1990" || pairs["2020,1990"] != "96,-180" {
		t.Errorf("connection pair = %v", pairs)
	}
	if pairs["84,-214"] != "260,-140" || pairs["260,-140"] != "84,-214" {
		t.Errorf("tag pair = %v", pairs)
	}
	if pairs["200,200"] != "" {
		t.Errorf("lone portal paired with %q", pairs["200,200"])
	}

	if len(s.Tombstones) != 2 || s.Tombstones[0].Owner != "Bjorn" || s.Tombstones[0].Day != 12 || s.Tombstones[1].Day != 38 {
		t.Errorf("tombstones = %+v", s.Tombstones)
	}
	if len(s.Beds) != 2 || s.Beds[0].Owner != "Ragnar" {
		t.Errorf("beds = %+v", s.Beds)
	}
	kinds := []string{}
	for _, v := range s.Vehicles {
		kinds = append(kinds, v.Kind)
	}
	if strings.Join(kinds, ",") != "Karve,Cart,Raft" {
		t.Errorf("vehicles = %v", kinds)
	}

	if len(s.Bases) == 0 {
		t.Fatal("no bases")
	}
	main := s.Bases[0]
	if main.Pieces < 36 || !main.HasBed || strings.Join(main.Stations, ",") != "forge,workbench" || main.X < 60 || main.X > 140 || main.Z < -240 || main.Z > -160 {
		t.Errorf("main base = %+v", main)
	}

	if !s.Explored.Available || s.Explored.Tables != 1 || s.Explored.Pixels == 0 {
		t.Errorf("explored = %+v", s.Explored)
	}
	mask := decodeRLE(t, s.Explored.RLE)
	if !maskAt(mask, 0, 0) || !maskAt(mask, 1000, 1000) || maskAt(mask, -3000, 3000) {
		t.Error("explored mask is not where the table put it")
	}

	if len(s.Pins) != 3 || s.Pins[1].Kind != "fire" || s.Pins[1].Name != "Home fire" || s.Pins[2].Kind != "boss" {
		t.Errorf("pins = %+v", s.Pins)
	}

	locs := map[string]Location{}
	for _, l := range s.Locations {
		locs[l.Name] = l
	}
	if len(locs) != 7 {
		t.Errorf("listed locations = %+v", s.Locations)
	}
	for name, want := range map[string][2]bool{ // placed, explored
		"StartTemple":        {true, true},
		"Eikthyrnir":         {true, true},
		"Crypt2":             {true, true}, // within 64 m of the base
		"TrollCave02":        {true, true}, // on the explored corridor
		"GDKing":             {false, false},
		"Vendor_BlackForest": {false, false},
		"Hildir_camp":        {true, false},
	} {
		l, ok := locs[name]
		if !ok || l.Placed != want[0] || l.Explored != want[1] {
			t.Errorf("%s = %+v, want placed %v explored %v", name, l, want[0], want[1])
		}
	}
	if s.Stats.LocationsTotal != 10 || s.Stats.LocationsPlaced != 7 {
		t.Errorf("location stats = %+v", s.Stats)
	}
	if locs["Eikthyrnir"].Kind != KindBoss || locs["Crypt2"].Kind != KindDungeon || locs["Hildir_camp"].Kind != KindTrader {
		t.Errorf("kinds = %+v", locs)
	}

	edits := map[[2]int]int{}
	for _, e := range s.TerrainEdits {
		edits[[2]int{e.X, e.Z}] = e.Cells
	}
	// Levelled 40 + both 10 + painted only 20 = 70; the second compiler only painted 5.
	if edits[[2]int{128, -192}] != 70 || edits[[2]int{0, 0}] != 5 {
		t.Errorf("terrain edits = %v", edits)
	}
}

func decodeRLE(t *testing.T, b []byte) []bool {
	t.Helper()
	mask := make([]bool, 0, exploredSize*exploredSize)
	on := false
	for i := 0; i < len(b); {
		n, shift := 0, 0
		for {
			c := b[i]
			i++
			n |= int(c&0x7f) << shift
			shift += 7
			if c&0x80 == 0 {
				break
			}
		}
		for k := 0; k < n; k++ {
			mask = append(mask, on)
		}
		on = !on
	}
	if len(mask) != exploredSize*exploredSize {
		t.Fatalf("rle covers %d pixels", len(mask))
	}
	return mask
}

func maskAt(mask []bool, x, z float32) bool {
	i, ok := explorePixel(x, z)
	return ok && mask[i]
}

func TestRLERoundTrip(t *testing.T) {
	m := make([]uint64, exploredWords)
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 5000; i++ {
		p := rng.Intn(exploredSize * exploredSize)
		m[p>>6] |= 1 << (p & 63)
	}
	for i := 100; i < 140; i++ {
		m[i] = ^uint64(0)
	}
	enc, px := rle(m)
	got := decodeRLE(t, enc)
	n := 0
	for i, on := range got {
		if on != (m[i>>6]&(1<<(i&63)) != 0) {
			t.Fatalf("pixel %d differs", i)
		}
		if on {
			n++
		}
	}
	if n != px {
		t.Errorf("pixels = %d, counted %d", px, n)
	}
}

// Platform ids and owner ids never leave the agent; names only with ShowNames.
func TestPrivacy(t *testing.T) {
	for _, names := range []bool{true, false} {
		j := string(build(t, fixture, names).Current().JSON)
		for _, secret := range []string{"Steam_", "Xbox_", "76561190000000099", "2533274900000077", "4611686018427387001", "tagauthor", "author", `"owner":-`} {
			if strings.Contains(j, secret) {
				t.Errorf("names=%v: map JSON contains %q", names, secret)
			}
		}
		for _, name := range []string{"Ragnar", "Bjorn", "Freya", "Home fire", "Copper here", `"tag":"home"`, `"tag":"mine"`, `"tag":"lost"`} {
			if got := strings.Contains(j, name); got != names {
				t.Errorf("names=%v: JSON contains %q = %v", names, name, got)
			}
		}
	}
}

func TestPairingSurvivesHiddenNames(t *testing.T) {
	s := build(t, fixture, false).Current().Snapshot
	paired := 0
	for _, p := range s.Portals {
		if p.Tag != "" {
			t.Errorf("tag exported: %+v", p)
		}
		if p.PairedWith != "" {
			paired++
		}
	}
	if paired != 4 {
		t.Errorf("paired portals = %d, want 4", paired)
	}
}

// writeGeneration writes `_main.<gen>.*` from the fixture's generation 3,
// bumping the revision of the chunk whose file starts with `bump`.
func writeGeneration(t *testing.T, dir string, gen int, bump string, content []byte) {
	t.Helper()
	for _, ext := range []string{".fwl2", ".db2"} {
		b, err := os.ReadFile(filepath.Join(dir, "_main.3"+ext))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "_main."+strconv.Itoa(gen)+ext), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := readIndex(filepath.Join(dir, "_main.3.chunks"))
	if err != nil {
		t.Fatal(err)
	}
	var idx bytes.Buffer
	_ = binary.Write(&idx, binary.LittleEndian, uint16(41))
	_ = binary.Write(&idx, binary.LittleEndian, int32(0))
	_ = binary.Write(&idx, binary.LittleEndian, int32(len(rows)))
	for _, r := range rows {
		old := filepath.Base(chunkFile(dir, r))
		if bump != "" && strings.HasPrefix(old, bump) {
			src, err := os.ReadFile(filepath.Join(dir, old))
			if err != nil {
				t.Fatal(err)
			}
			if content != nil {
				src = content
			}
			r.rev++
			if err := os.WriteFile(chunkFile(dir, r), src, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		idx.Write([]byte{r.id.x, r.id.z, r.id.g})
		_ = binary.Write(&idx, binary.LittleEndian, r.rev)
		_ = binary.Write(&idx, binary.LittleEndian, r.count)
	}
	if err := os.WriteFile(filepath.Join(dir, "_main."+strconv.Itoa(gen)+".chunks"), idx.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "_main."+strconv.Itoa(gen)+".ok"), []byte{41, 0, 0, 0}, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIncrementalRebuild(t *testing.T) {
	dir := copyDir(t, fixture)
	b := build(t, dir, true)
	first := b.Current()
	if first.Snapshot.Stats.ChunksParsed != 4 {
		t.Fatalf("first build parsed %d chunks", first.Snapshot.Stats.ChunksParsed)
	}

	// Same generation: nothing happens.
	changed, err := b.Refresh()
	if err != nil || changed || b.Current() != first {
		t.Fatalf("refresh without a new save: changed=%v err=%v", changed, err)
	}

	// A new generation that rewrote one chunk: only that chunk is parsed.
	writeGeneration(t, dir, 4, "00_01__0_", nil)
	changed, err = b.Refresh()
	if err != nil || !changed {
		t.Fatalf("refresh after a save: changed=%v err=%v", changed, err)
	}
	s := b.Current().Snapshot
	if s.Meta.Generation != 4 || s.Stats.ChunksParsed != 1 || len(s.Portals) != 5 || len(s.Tombstones) != 2 {
		t.Errorf("incremental snapshot: gen %d parsed %d portals %d tombs %d", s.Meta.Generation, s.Stats.ChunksParsed, len(s.Portals), len(s.Tombstones))
	}
	if b.Current().ETag == first.ETag {
		t.Error("a new generation kept the old ETag")
	}

	// An unfinished save (no .ok) is ignored.
	if err := os.WriteFile(filepath.Join(dir, "_main.5.chunks"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if changed, err := b.Refresh(); err != nil || changed {
		t.Errorf("unfinished save: changed=%v err=%v", changed, err)
	}
}

func TestCorruptChunkKeepsLastGood(t *testing.T) {
	dir := copyDir(t, fixture)
	b := build(t, dir, true)
	before := b.Current().Snapshot

	island, err := os.ReadFile(filepath.Join(dir, "20_20__1_4.chunk"))
	if err != nil {
		t.Fatal(err)
	}
	writeGeneration(t, dir, 4, "20_20__1_", island[:len(island)/2])
	if _, err := b.Refresh(); err != nil {
		t.Fatal(err)
	}
	s := b.Current().Snapshot
	if s.Stats.ChunksFailed != 1 || s.Stats.Pieces != before.Stats.Pieces || len(s.Beds) != len(before.Beds) || !s.Explored.Available {
		t.Errorf("corrupt chunk: failed %d pieces %d/%d beds %d", s.Stats.ChunksFailed, s.Stats.Pieces, before.Stats.Pieces, len(s.Beds))
	}

	// A fresh builder has no last good copy: the chunk is skipped, the rest stays.
	fresh := build(t, dir, true).Current().Snapshot
	if fresh.Stats.ChunksFailed != 1 || len(fresh.Portals) != 5 || len(fresh.Beds) != 1 || fresh.Explored.Available {
		t.Errorf("fresh build over a corrupt chunk: %+v portals %d beds %d", fresh.Stats, len(fresh.Portals), len(fresh.Beds))
	}

	// A broken index keeps the whole last snapshot.
	if err := os.WriteFile(filepath.Join(dir, "_main.6.chunks"), []byte{41, 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "_main.6.ok"), []byte{41, 0, 0, 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	last := b.Current()
	if _, err := b.Refresh(); err == nil {
		t.Error("broken index built a snapshot")
	}
	if b.Current() != last {
		t.Error("broken index replaced the last good snapshot")
	}
}

func TestParseChunkNeverPanics(t *testing.T) {
	good, err := os.ReadFile(filepath.Join(fixture, "20_20__1_4.chunk"))
	if err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 600; i++ {
		b := append([]byte(nil), good...)
		switch i % 3 {
		case 0:
			b = b[:rng.Intn(len(b))]
		case 1:
			for k := 0; k < 8; k++ {
				b[rng.Intn(len(b))] = byte(rng.Intn(256))
			}
		case 2:
			b = make([]byte, rng.Intn(512))
			rng.Read(b)
		}
		_, _ = parseChunk(b)
	}
}

func FuzzParseChunk(f *testing.F) {
	good, err := os.ReadFile(filepath.Join(fixture, "00_01__0_7.chunk"))
	if err != nil {
		f.Fatal(err)
	}
	f.Add(good)
	f.Fuzz(func(t *testing.T, b []byte) { _, _ = parseChunk(b) })
}

func TestTableBlobErrors(t *testing.T) {
	cd := newChunkData()
	if err := cd.addTable([]byte("not gzip")); err == nil {
		t.Error("garbage table accepted")
	}
	var raw bytes.Buffer
	zw := gzip.NewWriter(&raw)
	_ = binary.Write(zw, binary.LittleEndian, [2]int32{3, 99})
	_ = zw.Close()
	if err := cd.addTable(raw.Bytes()); err == nil || cd.explored != nil {
		t.Error("wrong-size mask accepted")
	}
}

func TestDisabledAndMissing(t *testing.T) {
	var nilB *Builder
	if nilB.Current() != nil || nilB.Enabled() {
		t.Error("nil builder")
	}
	b := New(Options{Logger: quiet})
	if _, err := b.Refresh(); err == nil || b.Enabled() {
		t.Error("disabled builder built")
	}
	b = New(Options{Dir: t.TempDir(), Logger: quiet})
	if _, err := b.Refresh(); err == nil || b.Current() != nil {
		t.Error("empty dir built a snapshot")
	}
}

func TestEncodedJSON(t *testing.T) {
	enc := build(t, fixture, true).Current()
	var back Snapshot
	if err := json.Unmarshal(enc.JSON, &back); err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(enc.Gzip))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if !bytes.Equal(plain, enc.JSON) {
		t.Error("gzip body differs from JSON")
	}
	if !strings.HasPrefix(enc.ETag, `"`) || len(enc.ETag) < 10 {
		t.Errorf("etag = %s", enc.ETag)
	}
	if len(back.Land.Data) != landSize*landSize {
		t.Errorf("land = %d bytes", len(back.Land.Data))
	}
}

func TestRunStopsWithContext(t *testing.T) {
	b := New(Options{Dir: fixture, Logger: quiet})
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	b.Run(ctx, 20*time.Millisecond)
	if b.Current() == nil {
		t.Error("Run did not build")
	}
}

// TestRealWorld builds the map of a played world when SKALD_REAL_WORLD
// points at its directory. Real saves hold private player data and never
// enter the repository; the expected counts are those of the world used to
// work out the format (a 1.0 save of about 376k objects).
func TestRealWorld(t *testing.T) {
	dir := os.Getenv("SKALD_REAL_WORLD")
	if dir == "" {
		t.Skip("SKALD_REAL_WORLD not set")
	}
	start := time.Now()
	b := build(t, dir, true)
	took := time.Since(start)
	s := b.Current().Snapshot
	paired := 0
	for _, p := range s.Portals {
		if p.PairedWith != "" {
			paired++
		}
	}
	if len(s.Portals) != 8 || paired != 4 {
		t.Errorf("portals = %d, paired = %d (want 8 and 2 pairs)", len(s.Portals), paired)
	}
	if len(s.Tombstones) != 5 || len(s.Beds) != 5 {
		t.Errorf("tombstones = %d, beds = %d", len(s.Tombstones), len(s.Beds))
	}
	if s.Explored.Tables != 1 || len(s.Pins) != 50 {
		t.Errorf("tables = %d, pins = %d", s.Explored.Tables, len(s.Pins))
	}
	if n := len(s.Bases); n < 12 || n > 16 {
		t.Errorf("bases = %d, want about 15", n)
	}
	if s.Stats.LocationsTotal != 12362 || s.Stats.LocationsPlaced != 948 {
		t.Errorf("locations = %d / %d placed", s.Stats.LocationsTotal, s.Stats.LocationsPlaced)
	}
	if s.Stats.ZDOs != 376222 || s.Stats.ChunksFailed != 0 {
		t.Errorf("stats = %+v", s.Stats)
	}
	if len(s.TerrainEdits) == 0 || len(s.TerrainEdits) > 33 {
		t.Errorf("terrain edits = %d", len(s.TerrainEdits))
	}
	// Pins are placed where people have been: nearly all inside the mask.
	mask := decodeRLE(t, s.Explored.RLE)
	in := 0
	for _, p := range s.Pins {
		if maskAt(mask, float32(p.X), float32(p.Z)) {
			in++
		}
	}
	if in*10 < len(s.Pins)*9 {
		t.Errorf("only %d/%d pins inside the explored mask", in, len(s.Pins))
	}
	if took > 2*time.Second {
		t.Errorf("build took %v", took)
	}
	// About 293k trees, rocks, bushes, ore and pickables outside dungeons and
	// above the seabed (about 23k seabed rocks and sunken logs are left out).
	if n := b.Current().Nature.Len(); n < 280000 || n > 310000 {
		t.Errorf("nature = %d objects", n)
	}
	t.Logf("build %v (%.3f s inside), JSON %d B, gzip %d B, bases %d, listed locations %d, nature %d",
		took, s.Stats.BuildSeconds, len(b.Current().JSON), len(b.Current().Gzip), len(s.Bases), len(s.Locations), b.Current().Nature.Len())
}
