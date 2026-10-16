package terrain

import (
	"compress/gzip"
	"context"
	"encoding/binary"
	"math"
	"os"
	"testing"
	"time"
)

func (f *fakeBridge) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// tilesAsked turns the bridge calls back into (z, x, y).
func (f *fakeBridge) tilesAsked() [][3]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out [][3]int
	for _, a := range f.asked {
		step := a[3]
		z := int(math.Round(math.Log2(2 * WorldRadius / (TileSize * step))))
		x := int(math.Round(((a[1]+WorldRadius)/step + 1.5) / TileSize))
		y := int(math.Round(((WorldRadius-a[2])/step + 1.5) / TileSize))
		out = append(out, [3]int{z, x, y})
	}
	return out
}

// The bake tests make a thousand tiles each: fast compression keeps them
// quick under -race.
func TestMain(m *testing.M) {
	gzipLevel = gzip.BestSpeed
	os.Exit(m.Run())
}

// bakeTiles bakes down to `level` with no pacing.
func bakeTiles(src Source, dir string, level int) *Tiles {
	ts := NewTiles(nil, TileOptions{Source: src, CacheDir: dir, CacheBytes: 512 << 20, Bake: true, Logger: quiet()})
	ts.bakeLevel, ts.bakeEvery, ts.bakeBusy, ts.bakeRetry, ts.viewerHold = level, 0, 0, 0, 0
	return ts
}

// waitBake waits for the bake of build to stop running.
func waitBake(t *testing.T, ts *Tiles, build string) *BakeStatus {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		ts.mu.Lock()
		running := ts.bake.build == build && ts.bake.state == "baking"
		stopped := ts.bake.build == ""
		ts.mu.Unlock()
		if !running || stopped {
			return ts.bakeStatus(build)
		}
		if time.Now().After(deadline) {
			t.Fatal("bake still running")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// rim reports whether a tile has a child outside the world.
func rim(z, x, y int) bool {
	for j := 0; j < 2; j++ {
		for i := 0; i < 2; i++ {
			if !TileInWorld(z+1, 2*x+i, 2*y+j) {
				return true
			}
		}
	}
	return false
}

// One bake, interrupted once: the order, the derived levels and the resume.
func TestBakeOrderAndResume(t *testing.T) {
	dir := t.TempDir()
	// The bridge goes away after 300 tiles.
	first := &fakeBridge{info: info, failAfter: 300}
	ts := bakeTiles(first, dir, 5)
	doc, err := ts.Doc(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st := waitBake(t, ts, doc.Build); st.Done >= st.Total || first.callCount() != 300 {
		t.Fatalf("status %+v after %d calls", st, first.callCount())
	}
	// A new agent on the same disk carries on where the first stopped.
	second := &fakeBridge{info: info}
	ts2 := bakeTiles(second, dir, 5)
	if _, err := ts2.Doc(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st := waitBake(t, ts2, doc.Build); st.State != "done" || st.Done != st.Total || st.Total != bakeTotal(5) {
		t.Fatalf("status %+v", st)
	}
	asked := append(first.tilesAsked(), second.tilesAsked()...)
	seen := map[[3]int]bool{}
	for _, a := range asked {
		if seen[a] {
			t.Fatalf("tile %v sampled twice", a)
		}
		seen[a] = true
	}
	// Levels 0..3 first, coarsest first.
	coarse := bakeTotal(PrewarmLevels)
	for i, a := range asked[:coarse] {
		if a[0] > PrewarmLevels || (i > 0 && a[0] < asked[i-1][0]) {
			t.Fatalf("call %d is %v", i, a)
		}
	}
	// Then the finest level, starting in a block at the centre.
	if a := asked[coarse]; a[0] != 5 || a[1]>>1 < 7 || a[1]>>1 > 8 || a[2]>>1 < 7 || a[2]>>1 > 8 {
		t.Fatalf("first fine tile %v is not at the centre", a)
	}
	// The level between is derived, except the rim, which comes last.
	rims := 0
	for i, a := range asked[coarse:] {
		if a[0] == 4 {
			if !rim(4, a[1], a[2]) {
				t.Fatalf("level 4 tile %v sampled, not derived", a)
			}
			if i+coarse < len(asked)-16 {
				t.Fatalf("rim tile %v sampled before the fine level was done", a)
			}
			rims++
		}
	}
	if fine := bakeTotal(5) - bakeTotal(4); len(asked) != coarse+fine+rims || rims != 16 {
		t.Fatalf("%d bridge calls: %d coarse, %d fine, %d rim", len(asked), coarse, fine, rims)
	}
	if s := ts2.Stats(); s.BakeDone != s.BakeTotal || s.Derived == 0 {
		t.Fatalf("stats %+v", s)
	}
	// A derived tile is served like any other.
	body, _, err := ts2.Tile(context.Background(), 4, 8, 8, doc.Build)
	if err != nil {
		t.Fatal(err)
	}
	if d := decode(t, gunzip(t, body)); d.flags != 3 || !near(d.step, MetresPerPixel(4), 1e-3) {
		t.Fatalf("derived tile flags %d step %v", d.flags, d.step)
	}
	// Done: a third start samples nothing.
	third := &fakeBridge{info: info}
	ts3 := bakeTiles(third, dir, 5)
	_, _ = ts3.Doc(context.Background())
	if st := waitBake(t, ts3, doc.Build); st.State != "done" || third.callCount() != 0 {
		t.Fatalf("status %+v after %d calls", st, third.callCount())
	}
}

func TestBakeStopsAtTheCacheBudget(t *testing.T) {
	fb := &fakeBridge{info: info}
	ts := bakeTiles(fb, t.TempDir(), 5)
	ts.cache.max = 64 << 10 // a few tiles
	doc, _ := ts.Doc(context.Background())
	if st := waitBake(t, ts, doc.Build); st.State != "budget" {
		t.Fatalf("status %+v", st)
	}
}

// childTile is a level-5 tile whose samples are functions of their global
// pixel (gx, gy) at that level: biome 3 except 5 on odd-odd pixels, height
// 1000 + gx, forest gx mod 256.
func childTile(tx, ty int) []byte {
	n := TileEdge
	b := make([]byte, n*n)
	h := make([]uint16, n*n)
	f := make([]byte, n*n)
	for j := 0; j < n; j++ {
		for i := 0; i < n; i++ {
			gx, gy := tx*TileSize+i-Apron, ty*TileSize+j-Apron
			k := j*n + i
			b[k] = 3
			if gx%2 == 1 && gy%2 == 1 {
				b[k] = 5
			}
			h[k] = uint16(1000 + gx)
			f[k] = byte(gx % 256)
		}
	}
	x0, z0, step := TileOrigin(5, tx, ty)
	raw := encodeTile(n, x0, z0, step, b, h)
	binary.LittleEndian.PutUint16(raw[6:], 3)
	return append(raw, f...)
}

func TestDeriveDownsamples(t *testing.T) {
	ts := NewTiles(nil, TileOptions{CacheDir: t.TempDir(), Logger: quiet()})
	const b = "build"
	// Tile 4/8/8: children 5/16..17/16..17, neighbours 15..18.
	for ty := 15; ty <= 18; ty++ {
		for tx := 15; tx <= 18; tx++ {
			if err := ts.cache.put(tilePath(b, 5, tx, ty), serve(childTile(tx, ty))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !ts.derivable(b, 4, 8, 8, true) {
		t.Fatal("not derivable with every neighbour on disk")
	}
	raw, err := ts.derive(b, 4, 8, 8)
	if err != nil {
		t.Fatal(err)
	}
	d := decode(t, gunzip(t, serve(raw)))
	if d.flags != 3 || !near(d.step, MetresPerPixel(4), 1e-3) {
		t.Fatalf("flags %d step %v", d.flags, d.step)
	}
	x0, z0, _ := TileOrigin(4, 8, 8)
	if !near(d.x0, x0, 1e-2) || !near(d.z0, z0, 1e-2) {
		t.Fatalf("origin %v %v", d.x0, d.z0)
	}
	n := d.n
	forest := raw[tileHeader+3*n*n:]
	for j := 0; j < n; j++ {
		for i := 0; i < n; i++ {
			k := j*n + i
			gx := 2 * (8*TileSize + i - Apron) // first child pixel under this one
			// Biome: the mode, 3 of the four are 3.
			if d.biomes[k] != 3 {
				t.Fatalf("pixel %d,%d biome %d", i, j, d.biomes[k])
			}
			// Height and forest: the mean of gx, gx+1 (twice), rounded.
			if want := uint16(1000 + gx + 1); d.heights[k] != want {
				t.Fatalf("pixel %d,%d height %d, want %d", i, j, d.heights[k], want)
			}
			if want := byte(gx%256 + 1); forest[k] != want {
				t.Fatalf("pixel %d,%d forest %d, want %d", i, j, forest[k], want)
			}
		}
	}
	// Without a neighbour the tile still derives (the bake's last pass),
	// the interior unchanged and the outer apron from the nearest sample.
	ts.cache.remove(tilePath(b, 5, 15, 16))
	if ts.derivable(b, 4, 8, 8, true) || !ts.derivable(b, 4, 8, 8, false) {
		t.Fatal("derivable with a neighbour missing")
	}
	raw2, err := ts.derive(b, 4, 8, 8)
	if err != nil {
		t.Fatal(err)
	}
	d2 := decode(t, gunzip(t, serve(raw2)))
	for j := 0; j < n; j++ {
		for i := 1; i < n; i++ {
			if d2.heights[j*n+i] != d.heights[j*n+i] {
				t.Fatalf("pixel %d,%d changed without the west neighbour", i, j)
			}
		}
	}
	// The outermost west sample repeats the children's own apron.
	if got, want := d2.heights[100*n], uint16(1000+2*8*TileSize-Apron); got != want {
		t.Fatalf("west apron %d, want %d", got, want)
	}
	// Without a child it cannot.
	ts.cache.remove(tilePath(b, 5, 16, 16))
	if ts.derivable(b, 4, 8, 8, false) {
		t.Fatal("derivable with a child missing")
	}
	if _, err := ts.derive(b, 4, 8, 8); err == nil {
		t.Fatal("derived with a child missing")
	}
}

func TestMode4(t *testing.T) {
	for _, c := range []struct {
		v    [4]byte
		want byte
	}{{[4]byte{1, 1, 1, 1}, 1}, {[4]byte{2, 1, 1, 3}, 1}, {[4]byte{1, 2, 2, 1}, 1}, {[4]byte{4, 3, 2, 1}, 4}, {[4]byte{4, 2, 3, 2}, 2}} {
		if got := mode4(c.v); got != c.want {
			t.Errorf("mode4(%v) = %d, want %d", c.v, got, c.want)
		}
	}
}

func TestRunStartsTheBakeWithoutViewers(t *testing.T) {
	fb := &fakeBridge{info: info}
	ts := NewTiles(nil, TileOptions{Source: fb, Bake: true, Logger: quiet()})
	ts.bakeEvery, ts.viewerHold = 0, 0
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go ts.Run(ctx)
	deadline := time.Now().Add(10 * time.Second)
	for fb.callCount() < bakeTotal(PrewarmLevels) {
		if time.Now().After(deadline) {
			t.Fatalf("%d tiles baked with nobody looking", fb.callCount())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
