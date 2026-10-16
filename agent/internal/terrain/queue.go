package terrain

// The one bridge slot and who gets it. Viewers' tiles wait in a priority
// queue, nearest the current view first; the bake (bake.go) gets the slot
// only when no viewer waits. A tile nobody waits for any more is dropped
// before the bridge samples it: when every viewer who asked for it went
// away (the request was cancelled), or when newer requests all landed far
// from it (the viewer moved on). Tiles the agent can make without the
// bridge (the Job's grid, or downsampled from the level below) skip the
// queue. Everyone asking for the same tile shares one job.

import (
	"context"
	"math"
	"net/http"
	"time"

	"github.com/krystianslowik/skald/agent/internal/bridge"
)

const (
	// viewRing is how many recent viewer requests are remembered.
	viewRing = 128
	// focusOf is how many of the latest requests make up the view's centre.
	focusOf = 16
	// staleTiles is how far (in the tile's own size) a queued tile may be
	// from every newer request before it counts as superseded: a phone
	// screen is about 6 x 10 tiles, a desktop about 12 x 8.
	staleTiles = 10
)

// job is one tile being made.
type job struct {
	key     string
	p       *plan
	z, x, y int
	order   uint64 // creation order, the last tie-break
	asked   uint64 // viewN at the latest viewer request for it
	waiters int    // viewers waiting for it
	bake    bool   // the bake waits for it too
	queued  bool   // waiting for the bridge
	done    chan struct{}
	body    []byte
	err     error
}

// view is one viewer request, for the queue's focus and staleness.
type view struct {
	seq     uint64
	z, x, y int
}

var errSuperseded = &TileError{http.StatusServiceUnavailable, "terrain tile superseded by a newer view"}

// noteView remembers a viewer request (cache hits too: panning over cached
// tiles still moves the view away from what is queued).
func (ts *Tiles) noteView(z, x, y int) {
	ts.mu.Lock()
	ts.viewN++
	ts.views[ts.viewN%viewRing] = view{ts.viewN, z, x, y}
	ts.viewAt = time.Now()
	ts.mu.Unlock()
}

// fetch makes a tile that is not cached yet, sharing the work with anyone
// else asking for it: a viewer (ctx is its request) or the bake.
func (ts *Tiles) fetch(ctx context.Context, p *plan, z, x, y int, bake bool) ([]byte, error) {
	key := tilePath(p.doc.Build, z, x, y)
	ts.mu.Lock()
	j, ok := ts.flight[key]
	if !ok {
		// Finished between the caller's cache miss and here.
		if ts.cache.has(key) {
			ts.mu.Unlock()
			if body, ok := ts.cache.get(key); ok {
				return body, nil
			}
			ts.mu.Lock()
		}
		if j, ok = ts.flight[key]; !ok {
			ts.jobs++
			j = &job{key: key, p: p, z: z, x: x, y: y, order: ts.jobs, done: make(chan struct{})}
			ts.flight[key] = j
			if mk := ts.local(p, z, x, y); mk != nil {
				go func() {
					raw, err := mk()
					ts.complete(j, raw, err)
				}()
			} else {
				j.queued = true
				ts.queue = append(ts.queue, j)
				if !ts.pumping {
					ts.pumping = true
					go ts.pump()
				}
			}
		}
	}
	if bake {
		j.bake = true
	} else {
		j.waiters++
		j.asked = ts.viewN
	}
	ts.mu.Unlock()
	select {
	case <-j.done:
		return j.body, j.err
	case <-ctx.Done():
		if !bake {
			ts.leave(j, ctx.Err())
		}
		return nil, ctx.Err()
	}
}

// local is how to make a tile without the bridge, or nil if only the
// bridge can.
func (ts *Tiles) local(p *plan, z, x, y int) func() ([]byte, error) {
	switch {
	case p.grid != nil && z <= p.doc.GridLevel:
		return func() ([]byte, error) {
			raw, err := gridTile(ts.t.opt.Dir, p.grid, p.doc.GridLevel, z, x, y)
			if err == nil {
				ts.count(&ts.stats.GridTiles)
			}
			return raw, err
		}
	case ts.derivable(p.doc.Build, z, x, y, true):
		return func() ([]byte, error) {
			raw, err := ts.derive(p.doc.Build, z, x, y)
			if err == nil {
				ts.count(&ts.stats.Derived)
			}
			return raw, err
		}
	case ts.opt.Source == nil:
		return func() ([]byte, error) { return nil, &TileError{http.StatusNotFound, "no source for this level"} }
	}
	return nil
}

// complete caches a finished tile and hands it to everyone waiting.
func (ts *Tiles) complete(j *job, raw []byte, err error) {
	var body []byte
	if err == nil {
		body = serve(raw)
		if err := ts.cache.put(j.key, body); err != nil {
			ts.opt.Logger.Debug("terrain tile not cached", "key", j.key, "err", err.Error())
		}
	} else {
		ts.count(&ts.stats.Errors)
		ts.opt.Logger.Debug("terrain tile failed", "z", j.z, "x", j.x, "y", j.y, "err", err.Error())
	}
	ts.mu.Lock()
	ts.finishLocked(j, body, err)
	ts.mu.Unlock()
}

func (ts *Tiles) finishLocked(j *job, body []byte, err error) {
	j.body, j.err = body, err
	delete(ts.flight, j.key)
	close(j.done)
}

// leave is a viewer giving up on a tile; the last one out drops it if the
// bridge has not started on it. A tile already being sampled finishes and
// is cached: the next pan may well want it.
func (ts *Tiles) leave(j *job, err error) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	j.waiters--
	if j.waiters > 0 || j.bake || !j.queued {
		return
	}
	ts.unqueueLocked(j)
	ts.stats.Dropped++
	ts.finishLocked(j, nil, err)
}

func (ts *Tiles) unqueueLocked(j *job) {
	for i, q := range ts.queue {
		if q == j {
			ts.queue = append(ts.queue[:i], ts.queue[i+1:]...)
			break
		}
	}
	j.queued = false
}

// pump runs the bridge slot until the queue is empty.
func (ts *Tiles) pump() {
	for {
		ts.mu.Lock()
		j := ts.nextLocked()
		if j == nil {
			ts.pumping = false
			ts.mu.Unlock()
			return
		}
		ts.mu.Unlock()
		// The deadline starts with the sampling, not in the queue.
		ctx, cancel := context.WithTimeout(context.Background(), 2*bridge.TerrainTimeout)
		raw, err := ts.bridgeTile(ctx, j.z, j.x, j.y)
		cancel()
		ts.complete(j, raw, err)
	}
}

// nextLocked drops what nobody wants any more and takes the next tile for
// the bridge: the viewers' tile nearest the view, else the bake's.
func (ts *Tiles) nextLocked() *job {
	fx, fz, focused := ts.focusLocked()
	var best, bakeJob *job
	var bestD float64
	for _, j := range append([]*job(nil), ts.queue...) {
		if j.waiters == 0 {
			if j.bake {
				if bakeJob == nil || j.order < bakeJob.order {
					bakeJob = j
				}
				continue
			}
			ts.unqueueLocked(j)
			ts.finishLocked(j, nil, context.Canceled)
			continue
		}
		if !j.bake && ts.staleLocked(j) {
			ts.unqueueLocked(j)
			ts.stats.Dropped++
			ts.finishLocked(j, nil, errSuperseded)
			continue
		}
		d := 0.0
		if focused {
			d = distToTile(fx, fz, j.z, j.x, j.y)
		}
		if best == nil || d < bestD || (d == bestD && (j.z < best.z || (j.z == best.z && j.order < best.order))) {
			best, bestD = j, d
		}
	}
	if best == nil {
		best = bakeJob
	}
	if best != nil {
		ts.unqueueLocked(best)
	}
	return best
}

// focusLocked is the centre of the latest viewer requests, in world metres.
func (ts *Tiles) focusLocked() (x, z float64, ok bool) {
	n := 0
	for s := ts.viewN; s > 0 && n < focusOf && ts.viewN-s < viewRing; s-- {
		v := ts.views[s%viewRing]
		w, e, no, so := tileRect(v.z, v.x, v.y)
		x += (w + e) / 2
		z += (no + so) / 2
		n++
	}
	if n == 0 {
		return 0, 0, false
	}
	return x / float64(n), z / float64(n), true
}

// staleLocked: viewers asked for other tiles since this one, and none of
// them anywhere near it.
func (ts *Tiles) staleLocked(j *job) bool {
	newer := false
	for s := ts.viewN; s > j.asked && ts.viewN-s < viewRing; s-- {
		newer = true
		v := ts.views[s%viewRing]
		if tileGap(v, j) <= staleTiles {
			return false
		}
	}
	return newer
}

// tileRect is a tile's west, east, north and south edges in world metres.
func tileRect(z, x, y int) (w, e, n, s float64) {
	span := 2 * WorldRadius / float64(int(1)<<z)
	w = -WorldRadius + float64(x)*span
	n = WorldRadius - float64(y)*span
	return w, w + span, n, n - span
}

// distToTile is the distance in metres from a point to a tile (0 inside it).
func distToTile(px, pz float64, z, x, y int) float64 {
	w, e, n, s := tileRect(z, x, y)
	dx := math.Max(0, math.Max(w-px, px-e))
	dz := math.Max(0, math.Max(s-pz, pz-n))
	return math.Hypot(dx, dz)
}

// tileGap is how far a request's tile is from a job's tile, in the job's
// tile size (0 when they overlap; levels may differ).
func tileGap(v view, j *job) float64 {
	vw, ve, vn, vs := tileRect(v.z, v.x, v.y)
	jw, je, jn, js := tileRect(j.z, j.x, j.y)
	dx := math.Max(0, math.Max(vw-je, jw-ve))
	dz := math.Max(0, math.Max(vs-jn, js-vn))
	return math.Max(dx, dz) / (je - jw)
}
