package terrain

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/world"
)

// fakeBridge answers like the plugin: world facts and tiles whose biome is
// the tile's call number, so a test can tell fresh tiles from cached ones.
type fakeBridge struct {
	mu      sync.Mutex
	info    bridge.TerrainInfo
	infoErr error
	calls   int
	asked   [][4]float64
	busy    int // answer 429 this many times first
	delay   time.Duration
	garbage bool
}

func (f *fakeBridge) TerrainInfo(context.Context) (*bridge.TerrainInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.infoErr != nil {
		return nil, f.infoErr
	}
	i := f.info
	return &i, nil
}

func (f *fakeBridge) TerrainTile(ctx context.Context, n int, x0, z0, step float64) ([]byte, int, error) {
	time.Sleep(f.delay)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.busy > 0 {
		f.busy--
		return nil, 0, &bridge.Error{Status: http.StatusTooManyRequests, Message: "terrain sampler busy"}
	}
	f.calls++
	f.asked = append(f.asked, [4]float64{float64(n), x0, z0, step})
	if f.garbage {
		return []byte("nope"), 1, nil
	}
	b := bytes.Repeat([]byte{byte(f.calls)}, n*n)
	h := make([]uint16, n*n)
	for i := range h {
		h[i] = uint16((40 + 500) * 50)
	}
	raw := encodeTile(n, x0, z0, step, b, h)
	// Add a forest channel and flag, as the plugin does.
	binary.LittleEndian.PutUint16(raw[6:], 3)
	raw = append(raw, bytes.Repeat([]byte{200}, n*n)...)
	return raw, 12, nil
}

var info = bridge.TerrainInfo{SeedHash: 4242, WorldGenVersion: 2, GameBuild: "l-1.0.17", WaterLevel: 30, Forest: "mask", Palette: bridge.TerrainPalette{Source: "none"}}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type decoded struct {
	n            int
	flags        uint16
	x0, z0, step float64
	biomes       []byte
	heights      []uint16
}

func decode(t *testing.T, raw []byte) decoded {
	t.Helper()
	if err := checkTile(raw, TileEdge); err != nil {
		t.Fatal(err)
	}
	n := int(binary.LittleEndian.Uint32(raw[8:]))
	d := decoded{
		n:      n,
		flags:  binary.LittleEndian.Uint16(raw[6:]),
		x0:     float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[12:]))),
		z0:     float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[16:]))),
		step:   float64(math.Float32frombits(binary.LittleEndian.Uint32(raw[20:]))),
		biomes: raw[tileHeader : tileHeader+n*n],
	}
	if d.flags&flagPacked == 0 {
		t.Fatal("served tile not packed")
	}
	d.flags &^= flagPacked
	// Undo packHeights: byte planes of west-to-east deltas.
	lo, hi := raw[tileHeader+n*n:], raw[tileHeader+2*n*n:]
	for r := 0; r < n; r++ {
		var v uint16
		for c := 0; c < n; c++ {
			i := r*n + c
			v += uint16(lo[i]) | uint16(hi[i])<<8
			d.heights = append(d.heights, v)
		}
	}
	return d
}

func near(a, b, eps float64) bool { return math.Abs(a-b) <= eps }

func TestPyramidGeometry(t *testing.T) {
	if got := MetresPerPixel(3); !near(got, 21000.0/2048, 1e-9) {
		t.Fatalf("level 3 is the Job's 2048 grid: %v m/px", got)
	}
	if got := MetresPerPixel(MaxLevel); got > 1 {
		t.Fatalf("top level %v m/px, want under 1", got)
	}
	// Pixel (0, 0) of tile 0/0/0 is centred half a pixel in from the north-west corner.
	x0, z0, step := TileOrigin(0, 0, 0)
	if !near(x0+Apron*step, -WorldRadius+step/2, 1e-9) || !near(z0-Apron*step, WorldRadius-step/2, 1e-9) {
		t.Fatalf("origin %v %v step %v", x0, z0, step)
	}
	// Neighbouring tiles share their apron: tile x+1's first pixel is tile x's apron.
	ax, _, _ := TileOrigin(4, 5, 7)
	bx, _, _ := TileOrigin(4, 6, 7)
	if !near(bx, ax+TileSize*MetresPerPixel(4), 1e-6) {
		t.Fatalf("tiles do not abut: %v %v", ax, bx)
	}
	for _, c := range []struct {
		z, x, y int
		in      bool
	}{{0, 0, 0, true}, {3, 0, 0, false}, {3, 3, 3, true}, {3, 7, 7, false}, {3, 0, 3, true}, {7, 64, 64, true}, {7, 0, 0, false}} {
		if got := TileInWorld(c.z, c.x, c.y); got != c.in {
			t.Errorf("TileInWorld(%d,%d,%d) = %v", c.z, c.x, c.y, got)
		}
	}
}

func gridOnly(t *testing.T, res int) (*Terrain, string) {
	t.Helper()
	dir := t.TempDir()
	m := good
	m.Resolution = res
	writeRun(t, dir, m, res)
	v := "l-1.0.17"
	terr := newTerrain(dir, &world.Meta{Seed: 4242, WorldGenVersion: 2}, &v)
	if err := terr.Refresh(); err != nil {
		t.Fatal(err)
	}
	return terr, dir
}

func newTerrainTiles(terr *Terrain, src Source, cache string) *Tiles {
	return NewTiles(terr, TileOptions{Source: src, CacheDir: cache, CacheBytes: 64 << 20, Logger: quiet()})
}

func gridTerrain(t *testing.T, res int) *Terrain {
	terr, _ := gridOnly(t, res)
	return terr
}

func TestGridFillsItsLevelsWithoutTheBridge(t *testing.T) {
	ts := newTerrainTiles(gridTerrain(t, 512), nil, t.TempDir())
	ctx := context.Background()
	doc, err := ts.Doc(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Source != "grid" || doc.MaxLevel != 1 || doc.GridLevel != 1 || doc.Forest != "none" {
		t.Fatalf("doc %+v", doc)
	}
	// Level 1 is the grid one to one: pixel (0, 0) is grid (0, 0), Meadows at 60 m.
	body, build, err := ts.Tile(ctx, 1, 0, 0, doc.Build)
	if err != nil || build != doc.Build {
		t.Fatal(err, build)
	}
	d := decode(t, gunzip(t, body))
	at := func(i, j int) (byte, float64) {
		k := (j+Apron)*d.n + i + Apron
		return d.biomes[k], float64(d.heights[k])/50 - 500
	}
	if b, h := at(0, 0); b != 1 || !near(h, 60, 0.02) {
		t.Fatalf("pixel 0,0: biome %d height %v", b, h)
	}
	if b, h := at(10, 0); b != 1 || !near(h, 65, 0.02) {
		t.Fatalf("pixel 10,0: biome %d height %v", b, h)
	}
	// The apron past the world's edge repeats the edge.
	if k := Apron*d.n + Apron; d.biomes[0] != d.biomes[k] || d.heights[0] != d.heights[k] {
		t.Fatal("apron does not repeat the edge")
	}
	// Level 0 averages 2 x 2 grid pixels: (60 + 60.5) / 2, and the south half is sea.
	body, _, err = ts.Tile(ctx, 0, 0, 0, doc.Build)
	if err != nil {
		t.Fatal(err)
	}
	d = decode(t, gunzip(t, body))
	if b, h := at(0, 0); b != 1 || !near(h, 60.25, 0.02) {
		t.Fatalf("level 0 pixel 0,0: biome %d height %v", b, h)
	}
	if b, _ := at(0, 200); b != 8 {
		t.Fatalf("level 0 south: biome %d", b)
	}
	if !near(d.step, MetresPerPixel(0), 1e-3) {
		t.Fatalf("step %v", d.step)
	}
	// Past the grid's levels there is nothing without the bridge.
	var te *TileError
	if _, _, err := ts.Tile(ctx, 2, 1, 1, doc.Build); !errors.As(err, &te) || te.Status != http.StatusNotFound {
		t.Fatalf("level 2 without the bridge: %v", err)
	}
}

func TestBridgeTilesAreCachedAndKeyed(t *testing.T) {
	fb := &fakeBridge{info: info}
	cache := t.TempDir()
	ts := newTerrainTiles(nil, fb, cache)
	ctx := context.Background()
	doc, err := ts.Doc(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Source != "bridge" || doc.MaxLevel != MaxLevel || doc.GridLevel != -1 || doc.Forest != "mask" {
		t.Fatalf("doc %+v", doc)
	}
	body, _, err := ts.Tile(ctx, 5, 16, 16, doc.Build)
	if err != nil {
		t.Fatal(err)
	}
	raw := gunzip(t, body)
	if d := decode(t, raw); d.flags != 3 || d.biomes[0] != 1 {
		t.Fatalf("flags %d first biome %d", d.flags, d.biomes[0])
	}
	x0, z0, step := TileOrigin(5, 16, 16)
	if a := fb.asked[0]; a != [4]float64{TileEdge, x0, z0, step} {
		t.Fatalf("asked the bridge for %v", a)
	}
	// Again: from the cache, no second bridge call.
	if _, _, err := ts.Tile(ctx, 5, 16, 16, doc.Build); err != nil || fb.calls != 1 {
		t.Fatal(err, fb.calls)
	}
	// A restart reads the disk cache.
	ts2 := newTerrainTiles(nil, fb, cache)
	if _, _, err := ts2.Tile(ctx, 5, 16, 16, doc.Build); err != nil || fb.calls != 1 {
		t.Fatal(err, fb.calls)
	}
	// A game update is a new build: old URLs 404, new tiles are sampled again.
	fb.mu.Lock()
	fb.info.GameBuild = "l-1.0.18"
	fb.mu.Unlock()
	ts.mu.Lock()
	ts.infoAt = time.Time{}
	ts.mu.Unlock()
	doc2, _ := ts.Doc(ctx)
	if doc2.Build == doc.Build {
		t.Fatal("build did not change with the game build")
	}
	var te *TileError
	if _, _, err := ts.Tile(ctx, 5, 16, 16, doc.Build); !errors.As(err, &te) || te.Status != http.StatusNotFound {
		t.Fatalf("old build: %v", err)
	}
	if _, _, err := ts.Tile(ctx, 5, 16, 16, doc2.Build); err != nil || fb.calls != 2 {
		t.Fatal(err, fb.calls)
	}
	// Out of range and outside the world.
	for _, c := range [][3]int{{8, 0, 0}, {2, 4, 0}, {-1, 0, 0}, {3, 0, 0}} {
		if _, _, err := ts.Tile(ctx, c[0], c[1], c[2], ""); !errors.As(err, &te) || te.Status != http.StatusNotFound {
			t.Errorf("tile %v: %v", c, err)
		}
	}
}

func TestGridServesLowLevelsOnlyForTheSameBuild(t *testing.T) {
	ctx := context.Background()
	fb := &fakeBridge{info: info}
	ts := newTerrainTiles(gridTerrain(t, 512), fb, t.TempDir())
	doc, _ := ts.Doc(ctx)
	if doc.Source != "bridge" || doc.GridLevel != 1 {
		t.Fatalf("doc %+v", doc)
	}
	if _, _, err := ts.Tile(ctx, 1, 0, 1, doc.Build); err != nil || fb.calls != 0 {
		t.Fatalf("grid level went to the bridge: %v calls %d", err, fb.calls)
	}
	if _, _, err := ts.Tile(ctx, 2, 1, 1, doc.Build); err != nil || fb.calls != 1 {
		t.Fatalf("level 2: %v calls %d", err, fb.calls)
	}
	// Another game build than the grid's: every level from the bridge.
	fb2 := &fakeBridge{info: info}
	fb2.info.GameBuild = "l-1.0.18"
	ts2 := newTerrainTiles(gridTerrain(t, 512), fb2, t.TempDir())
	doc2, _ := ts2.Doc(ctx)
	if doc2.GridLevel != -1 {
		t.Fatalf("stale grid used: %+v", doc2)
	}
	if _, _, err := ts2.Tile(ctx, 0, 0, 0, doc2.Build); err != nil || fb2.calls != 1 {
		t.Fatalf("level 0: %v calls %d", err, fb2.calls)
	}
}

func TestBridgeDownFallsBackToTheGrid(t *testing.T) {
	fb := &fakeBridge{infoErr: &bridge.Error{Status: http.StatusBadGateway, Message: "bridge unavailable"}}
	ts := newTerrainTiles(gridTerrain(t, 256), fb, "")
	doc, err := ts.Doc(context.Background())
	if err != nil || doc.Source != "grid" || doc.MaxLevel != 0 {
		t.Fatalf("doc %+v err %v", doc, err)
	}
	// Neither: nothing.
	ts = newTerrainTiles(nil, fb, "")
	if _, err := ts.Doc(context.Background()); err == nil {
		t.Fatal("doc without a source")
	}
}

func TestConcurrentRequestsShareOneBridgeCall(t *testing.T) {
	fb := &fakeBridge{info: info, delay: 30 * time.Millisecond}
	ts := newTerrainTiles(nil, fb, "")
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := ts.Tile(context.Background(), 6, 32, 32, ""); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if fb.calls != 1 {
		t.Fatalf("%d bridge calls", fb.calls)
	}
}

func TestBusyBridgeIsRetriedAndGarbageNotCached(t *testing.T) {
	fb := &fakeBridge{info: info, busy: 2}
	ts := newTerrainTiles(nil, fb, "")
	if _, _, err := ts.Tile(context.Background(), 4, 8, 8, ""); err != nil || fb.calls != 1 {
		t.Fatalf("after 429s: %v calls %d", err, fb.calls)
	}
	fb.garbage = true
	var te *TileError
	if _, _, err := ts.Tile(context.Background(), 4, 8, 9, ""); !errors.As(err, &te) || te.Status != http.StatusBadGateway {
		t.Fatalf("garbage: %v", err)
	}
	if _, n := ts.cache.size(); n != 1 {
		t.Fatalf("%d tiles cached, want 1", n)
	}
	// A cancelled viewer does not cancel the tile for the next one.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	fb.garbage = false
	if _, _, err := ts.Tile(ctx, 4, 9, 9, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestCacheEvictsLeastRecentlyUsed(t *testing.T) {
	dir := t.TempDir()
	c, err := openTileCache(dir, 100)
	if err != nil {
		t.Fatal(err)
	}
	blob := func(b byte) []byte { return bytes.Repeat([]byte{b}, 40) }
	for _, k := range []string{"b1/0/0-0.skt.gz", "b1/1/0-0.skt.gz"} {
		if err := c.put(k, blob(1)); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Touch the first: the second becomes the oldest.
	if _, ok := c.get("b1/0/0-0.skt.gz"); !ok {
		t.Fatal("miss")
	}
	time.Sleep(10 * time.Millisecond)
	if err := c.put("b2/0/0-0.skt.gz", blob(2)); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.get("b1/1/0-0.skt.gz"); ok {
		t.Fatal("least recently used tile kept")
	}
	if _, err := os.Stat(filepath.Join(dir, "b1", "1")); !os.IsNotExist(err) {
		t.Fatal("empty level directory kept")
	}
	if total, n := c.size(); total != 80 || n != 2 {
		t.Fatalf("size %d, %d tiles", total, n)
	}
	// Reopened with a smaller bound: the index comes back from mtimes and the oldest goes.
	c2, err := openTileCache(dir, 50)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c2.get("b2/0/0-0.skt.gz"); !ok {
		t.Fatal("newest tile lost on reopen")
	}
	if _, ok := c2.get("b1/0/0-0.skt.gz"); ok {
		t.Fatal("over-bound tile kept on reopen")
	}
	if err := c2.put("big", make([]byte, 51)); err == nil {
		t.Fatal("a tile larger than the cache was accepted")
	}
	// Memory-only mode behaves the same.
	m, _ := openTileCache("", 100)
	_ = m.put("a", blob(1))
	_ = m.put("b", blob(2))
	_ = m.put("c", blob(3))
	if _, ok := m.get("a"); ok {
		t.Fatal("memory cache kept the oldest")
	}
	if b, ok := m.get("c"); !ok || b[0] != 3 {
		t.Fatal("memory cache lost the newest")
	}
}
