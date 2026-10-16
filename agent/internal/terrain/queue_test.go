package terrain

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"
)

// heldBridge answers each tile only when the test lets it.
func heldBridge() *fakeBridge {
	return &fakeBridge{info: info, in: make(chan struct{}, 64), hold: make(chan struct{})}
}

// queued waits until n tiles wait for the bridge.
func queued(t *testing.T, ts *Tiles, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ts.mu.Lock()
		got := len(ts.queue)
		ts.mu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d tiles queued, want %d", got, n)
		}
		time.Sleep(time.Millisecond)
	}
}

type result struct {
	tile [3]int
	err  error
}

// ask requests tiles in the background, in order, each queued before the next.
func ask(t *testing.T, ts *Tiles, ctx context.Context, out chan<- result, tiles ...[3]int) {
	t.Helper()
	for _, c := range tiles {
		ts.mu.Lock()
		before := len(ts.queue)
		ts.mu.Unlock()
		go func(c [3]int) {
			_, _, err := ts.Tile(ctx, c[0], c[1], c[2], "")
			out <- result{c, err}
		}(c)
		queued(t, ts, before+1)
	}
}

// hold starts tile `first` and keeps the bridge busy with it.
func holdBridge(t *testing.T, ts *Tiles, fb *fakeBridge, out chan<- result, first [3]int) {
	t.Helper()
	go func() {
		_, _, err := ts.Tile(context.Background(), first[0], first[1], first[2], "")
		out <- result{first, err}
	}()
	<-fb.in
}

func TestQueueServesTheNearestTileFirst(t *testing.T) {
	fb := heldBridge()
	ts := newTerrainTiles(nil, fb, "")
	out := make(chan result, 16)
	holdBridge(t, ts, fb, out, [3]int{7, 64, 64})
	a, b, c := [3]int{7, 60, 64}, [3]int{7, 68, 64}, [3]int{7, 64, 66}
	ask(t, ts, context.Background(), out, a, b, c)
	// The viewer moves east: B is now nearest, then C, then A.
	for i := 0; i < focusOf; i++ {
		ts.noteView(7, 68, 64)
	}
	close(fb.hold)
	for i := 0; i < 4; i++ {
		if r := <-out; r.err != nil {
			t.Fatal(r.tile, r.err)
		}
	}
	got := fb.tilesAsked()
	want := [][3]int{{7, 64, 64}, b, c, a}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("bridge order %v, want %v", got, want)
		}
	}
}

func TestQueueDropsCancelledAndSupersededTiles(t *testing.T) {
	fb := heldBridge()
	ts := newTerrainTiles(nil, fb, "")
	out := make(chan result, 16)
	holdBridge(t, ts, fb, out, [3]int{7, 64, 64})
	// A viewer gives up on one tile.
	ctx, cancel := context.WithCancel(context.Background())
	gone := [3]int{7, 65, 64}
	ask(t, ts, ctx, out, gone)
	cancel()
	if r := <-out; r.tile != gone || !errors.Is(r.err, context.Canceled) {
		t.Fatalf("cancelled: %v %v", r.tile, r.err)
	}
	queued(t, ts, 0)
	// Another asks for a tile far west, then pans east: everything newer is
	// far from it, so it is dropped; the one next to the new view is not.
	far, kept := [3]int{7, 40, 64}, [3]int{7, 62, 64}
	ask(t, ts, context.Background(), out, far, kept)
	ts.noteView(7, 64, 64)
	ts.noteView(7, 63, 65)
	close(fb.hold)
	got := map[[3]int]error{}
	for i := 0; i < 3; i++ {
		r := <-out
		got[r.tile] = r.err
	}
	var te *TileError
	if err := got[far]; !errors.As(err, &te) || te.Status != http.StatusServiceUnavailable {
		t.Fatalf("far tile: %v", err)
	}
	if got[kept] != nil {
		t.Fatalf("near tile: %v", got[kept])
	}
	for _, a := range fb.tilesAsked() {
		if a == gone || a == far {
			t.Fatalf("the bridge sampled %v, which nobody wanted", a)
		}
	}
	if fb.callCount() != 2 || ts.Stats().Dropped != 2 {
		t.Fatalf("%d calls, %d dropped", fb.callCount(), ts.Stats().Dropped)
	}
	// A request with no newer one is never superseded, however far.
	fb.hold = nil
	if _, _, err := ts.Tile(context.Background(), 7, 20, 64, ""); err != nil {
		t.Fatal(err)
	}
}

func TestViewersGoBeforeTheBakeAndShareItsTiles(t *testing.T) {
	fb := heldBridge()
	ts := newTerrainTiles(nil, fb, t.TempDir())
	p, err := ts.plan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := make(chan result, 16)
	holdBridge(t, ts, fb, out, [3]int{7, 64, 64})
	// The bake queues two tiles, then viewers want one of them and another.
	var wg sync.WaitGroup
	shared, bakeOnly, viewer := [3]int{7, 70, 70}, [3]int{7, 71, 70}, [3]int{7, 66, 66}
	for i, c := range [][3]int{bakeOnly, shared} {
		wg.Add(1)
		go func(c [3]int) {
			defer wg.Done()
			if _, err := ts.fetch(context.Background(), p, c[0], c[1], c[2], true); err != nil {
				t.Error(err)
			}
		}(c)
		queued(t, ts, i+1)
	}
	ask(t, ts, context.Background(), out, viewer)
	go func() {
		_, _, err := ts.Tile(context.Background(), shared[0], shared[1], shared[2], "")
		out <- result{shared, err}
	}()
	// The viewer joins the bake's job: still three queued.
	deadline := time.Now().Add(5 * time.Second)
	for {
		ts.mu.Lock()
		w := ts.flight[tilePath(p.doc.Build, shared[0], shared[1], shared[2])].waiters
		ts.mu.Unlock()
		if w == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the viewer did not join the bake's tile")
		}
		time.Sleep(time.Millisecond)
	}
	queued(t, ts, 3)
	close(fb.hold)
	wg.Wait()
	for i := 0; i < 3; i++ {
		if r := <-out; r.err != nil {
			t.Fatal(r.tile, r.err)
		}
	}
	got := fb.tilesAsked()
	if len(got) != 4 || got[3] != bakeOnly {
		t.Fatalf("bridge order %v: the bake-only tile must come last, once", got)
	}
}
