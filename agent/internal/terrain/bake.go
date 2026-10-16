package terrain

// The background bake: the whole pyramid of a bridge build on disk, so the
// map never waits for the bridge where nobody has looked yet.
//
// Order: levels 0..PrewarmLevels from the bridge (85 tiles, the whole-world
// view), then the finest level over the whole world disc, one level-4
// block (8 x 8 finest tiles) at a time, the blocks nearest the centre
// first. Levels 4..6 are not sampled: each is downsampled from the level
// below as soon as a tile's children and their neighbours are on disk
// (derive), which frees the bridge for the level only it can make. Tiles
// whose children leave the world disc (the rim, 164 tiles) are sampled at
// the end.
//
// Cost, from a live server (106 ms of sampling per tile; the plugin rests
// as long again, its 50 % duty cycle): 13,104 finest tiles + 85 + 164 rim
// = 13,353 bridge calls. One every 300 ms (bakeEvery, under the plugin's
// 4/s rate limit so a viewer still finds tokens) is about 67 minutes per
// game build and about a third of one core while it runs; one a second
// while players are online, about 3.7 hours. Viewers always go first, and
// the bake holds off for viewerHold after any viewer request.
//
// Disk: about 43 KB per finest tile, 55-70 KB per derived one (live
// averages, over land; ocean tiles are a few KB), so about 0.5-0.85 GB per
// build. It fits DefaultCacheBytes; the bake stops ("budget") rather than
// evict its own tiles once a build holds 90 % of the cache.
//
// Resume: the cache on disk is the progress. A restarted agent walks the
// same order and skips every tile already there.

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"time"
)

const (
	// blockLevel is the level whose tiles are the bake's units of work.
	blockLevel = PrewarmLevels + 1
	// bakeEvery is the pace of bridge calls when nobody plays, bakeBusyEvery
	// while players are online.
	bakeEvery     = 300 * time.Millisecond
	bakeBusyEvery = time.Second
	// viewerHold: no bake tile starts this soon after a viewer request.
	viewerHold = 2 * time.Second
	// bakeRetry is the wait after a failed tile (the bridge busy or away).
	bakeRetry = 10 * time.Second
	// bakeBudget is the share of the cache one build may fill.
	bakeBudget = 0.9
)

// BakeStatus is the bake's progress, in /terrain/tiles.json.
type BakeStatus struct {
	// State: "baking", "done", "budget" (stopped: the cache is too small),
	// "memory" (no disk cache: levels 0..3 only), "waiting" (not started for
	// this build yet) or "off" (TERRAIN_BAKE=false).
	State string `json:"state"`
	// Done is the build's tiles on disk, out of Total (every tile of levels
	// 0..Level that touches the world).
	Done  int `json:"done"`
	Total int `json:"total"`
	Level int `json:"level"`
}

type bakeState struct {
	build string // the build the bake runs (or ran) for; "" restarts it
	state string
	at    time.Time // the last bake tile's start
}

var errBakeStopped = errors.New("terrain bake stopped: the bridge or the build changed")

// Run asks the bridge for its world facts every minute even when nobody
// opens the map, so a new game build (or the bridge coming up after the
// world loads) starts its bake on an idle server too.
func (ts *Tiles) Run(ctx context.Context) {
	if !ts.opt.Bake || ts.opt.Source == nil {
		return
	}
	t := time.NewTicker(infoEvery)
	defer t.Stop()
	for {
		_, _ = ts.Doc(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// startBake starts the bake of p's build once per agent run (again after
// it stopped on an error).
func (ts *Tiles) startBake(p *plan) {
	if !ts.opt.Bake {
		return
	}
	b := p.doc.Build
	ts.mu.Lock()
	if ts.bake.build == b {
		ts.mu.Unlock()
		return
	}
	ts.bake = bakeState{build: b, state: "baking"}
	ts.mu.Unlock()
	go func() {
		state, err := ts.runBake(p)
		ts.mu.Lock()
		defer ts.mu.Unlock()
		if ts.bake.build != b {
			return
		}
		if err != nil {
			ts.bake.build, ts.bake.state = "", ""
			ts.opt.Logger.Info("terrain bake paused", "build", b, "reason", err.Error())
			return
		}
		ts.bake.state = state
	}()
}

func (ts *Tiles) runBake(p *plan) (string, error) {
	b := p.doc.Build
	have, _ := ts.cache.countPrefix(b + "/")
	total := bakeTotal(ts.bakeLevel)
	if have < total {
		ts.opt.Logger.Info("terrain bake started", "build", b, "tiles", have, "of", total)
	}
	for z := 0; z <= min(PrewarmLevels, ts.bakeLevel); z++ {
		for y := 0; y < 1<<z; y++ {
			for x := 0; x < 1<<z; x++ {
				if TileInWorld(z, x, y) {
					if err := ts.bakeTile(&p, z, x, y); err != nil {
						return "", err
					}
				}
			}
		}
	}
	if ts.cache.dir == "" {
		// A memory cache would only churn.
		return "memory", nil
	}
	L := ts.bakeLevel
	blocks := bakeBlocks()
	for _, bl := range blocks {
		if _, size := ts.cache.countPrefix(b + "/"); float64(size) > bakeBudget*float64(ts.cache.max) {
			ts.opt.Logger.Warn("terrain bake stopped: the cache is full, raise TERRAIN_CACHE_MB", "build", b)
			return "budget", nil
		}
		np, err := ts.plan(context.Background())
		if err != nil || np.doc.Build != b || np.doc.Source != "bridge" {
			return "", errBakeStopped
		}
		p = np
		k := 1 << (L - blockLevel)
		for y := bl[1] * k; y < (bl[1]+1)*k; y++ {
			for x := bl[0] * k; x < (bl[0]+1)*k; x++ {
				if TileInWorld(L, x, y) {
					if err := ts.bakeTile(&p, L, x, y); err != nil {
						return "", err
					}
				}
			}
		}
		// Downsample what this block completed, here and in its neighbours
		// (whose aprons needed it).
		ts.deriveAround(b, bl[0], bl[1])
	}
	// What is left: the rim, and tiles whose children failed.
	for z := L - 1; z >= blockLevel; z-- {
		for y := 0; y < 1<<z; y++ {
			for x := 0; x < 1<<z; x++ {
				if !TileInWorld(z, x, y) || ts.cache.has(tilePath(b, z, x, y)) {
					continue
				}
				if ts.derivable(b, z, x, y, false) {
					ts.deriveTile(b, z, x, y)
					continue
				}
				if err := ts.bakeTile(&p, z, x, y); err != nil {
					return "", err
				}
			}
		}
	}
	n, size := ts.cache.countPrefix(b + "/")
	if have < total {
		ts.opt.Logger.Info("terrain bake done", "build", b, "tiles", n, "of", total, "mb", size>>20)
	}
	return "done", nil
}

// bakeBlocks are the level-4 tiles in the world, nearest the centre first.
func bakeBlocks() [][2]int {
	var out [][2]int
	for y := 0; y < 1<<blockLevel; y++ {
		for x := 0; x < 1<<blockLevel; x++ {
			if TileInWorld(blockLevel, x, y) {
				out = append(out, [2]int{x, y})
			}
		}
	}
	c := float64(int(1)<<blockLevel) / 2
	d := func(b [2]int) float64 { return math.Hypot(float64(b[0])+0.5-c, float64(b[1])+0.5-c) }
	sort.SliceStable(out, func(i, j int) bool { return d(out[i]) < d(out[j]) })
	return out
}

// bakeTotal is the number of tiles of levels 0..level in the world.
func bakeTotal(level int) int {
	n := 0
	for z := 0; z <= level; z++ {
		for y := 0; y < 1<<z; y++ {
			for x := 0; x < 1<<z; x++ {
				if TileInWorld(z, x, y) {
					n++
				}
			}
		}
	}
	return n
}

// deriveAround downsamples every missing tile of levels blockLevel..L-1 in
// block (bx, by) and its eight neighbours whose children and their
// neighbours are all on disk, finest first.
func (ts *Tiles) deriveAround(b string, bx, by int) {
	for z := ts.bakeLevel - 1; z >= blockLevel; z-- {
		k := 1 << (z - blockLevel)
		for y := (by - 1) * k; y < (by+2)*k; y++ {
			for x := (bx - 1) * k; x < (bx+2)*k; x++ {
				if x < 0 || y < 0 || x >= 1<<z || y >= 1<<z || !TileInWorld(z, x, y) || ts.cache.has(tilePath(b, z, x, y)) {
					continue
				}
				if ts.derivable(b, z, x, y, true) {
					ts.deriveTile(b, z, x, y)
				}
			}
		}
	}
}

func (ts *Tiles) deriveTile(b string, z, x, y int) {
	raw, err := ts.derive(b, z, x, y)
	if err != nil {
		ts.opt.Logger.Debug("terrain tile not derived", "z", z, "x", x, "y", y, "err", err.Error())
		return
	}
	ts.count(&ts.stats.Derived)
	if err := ts.cache.put(tilePath(b, z, x, y), serve(raw)); err != nil {
		ts.opt.Logger.Debug("terrain tile not cached", "z", z, "x", x, "y", y, "err", err.Error())
	}
}

// bakeTile has the bridge sample one tile at the bake's pace, unless it is
// on disk already. A tile that keeps failing is skipped (viewers still get
// it on demand); a 404 (the build changed, the bridge went away) stops the
// bake.
func (ts *Tiles) bakeTile(pp **plan, z, x, y int) error {
	p := *pp
	if ts.cache.has(tilePath(p.doc.Build, z, x, y)) {
		return nil
	}
	for attempt := 0; ; attempt++ {
		if p.grid == nil || z > p.doc.GridLevel {
			ts.pace()
		}
		_, err := ts.fetch(context.Background(), p, z, x, y, true)
		if err == nil {
			return nil
		}
		var te *TileError
		if errors.As(err, &te) && te.Status == http.StatusNotFound {
			return err
		}
		if attempt == 2 {
			ts.opt.Logger.Debug("terrain bake skipped a tile", "z", z, "x", x, "y", y, "err", err.Error())
			return nil
		}
		time.Sleep(ts.bakeRetry)
		np, perr := ts.plan(context.Background())
		if perr != nil || np.doc.Build != p.doc.Build || np.doc.Source != "bridge" {
			return errBakeStopped
		}
		p, *pp = np, np
	}
}

// pace waits for the bake's next turn: bakeEvery after the last bake tile
// started (bakeBusyEvery while players are online), and viewerHold after
// the last viewer request.
func (ts *Tiles) pace() {
	for {
		every := ts.bakeEvery
		if ts.opt.PlayersOnline != nil && ts.opt.PlayersOnline() {
			every = ts.bakeBusy
		}
		ts.mu.Lock()
		wait := time.Until(ts.bake.at.Add(every))
		if !ts.viewAt.IsZero() {
			wait = max(wait, time.Until(ts.viewAt.Add(ts.viewerHold)))
		}
		if wait <= 0 {
			ts.bake.at = time.Now()
			ts.mu.Unlock()
			return
		}
		ts.mu.Unlock()
		time.Sleep(wait)
	}
}

// bakeStatus is the bake's progress for build b.
func (ts *Tiles) bakeStatus(b string) *BakeStatus {
	if !ts.opt.Bake {
		return &BakeStatus{State: "off"}
	}
	ts.mu.Lock()
	state := "waiting"
	if ts.bake.build == b {
		state = ts.bake.state
	}
	ts.mu.Unlock()
	n, _ := ts.cache.countPrefix(b + "/")
	total := bakeTotal(ts.bakeLevel)
	return &BakeStatus{State: state, Done: min(n, total), Total: total, Level: ts.bakeLevel}
}

// ---- downsampling --------------------------------------------------------

// tileData is a decoded tile.
type tileData struct {
	flags   uint16 // without flagPacked
	biomes  []byte
	heights []uint16
	forest  []byte // nil without the forest channel
}

// decodeServed undoes serve: gunzip, then the packed heights.
func decodeServed(body []byte) (*tileData, error) {
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.Grow(tileHeader + TileEdge*TileEdge*4 + 1)
	if _, err := io.Copy(&buf, io.LimitReader(zr, int64(tileHeader+TileEdge*TileEdge*4+1))); err != nil {
		return nil, err
	}
	raw := buf.Bytes()
	if err := checkTile(raw, TileEdge); err != nil {
		return nil, err
	}
	n := TileEdge
	nn := n * n
	flags := binary.LittleEndian.Uint16(raw[6:])
	d := &tileData{flags: flags &^ flagPacked, biomes: raw[tileHeader : tileHeader+nn], heights: make([]uint16, nn)}
	h := raw[tileHeader+nn : tileHeader+3*nn]
	if flags&flagPacked != 0 {
		for r := 0; r < n; r++ {
			var v uint16
			for c := 0; c < n; c++ {
				i := r*n + c
				v += uint16(h[i]) | uint16(h[nn+i])<<8
				d.heights[i] = v
			}
		}
	} else {
		for i := range d.heights {
			d.heights[i] = binary.LittleEndian.Uint16(h[2*i:])
		}
	}
	if flags&1 != 0 {
		d.forest = raw[tileHeader+3*nn : tileHeader+4*nn]
	}
	return d, nil
}

// derivable reports whether tile (z, x, y) can be downsampled from level
// z+1: its four children are in the world and on disk and, when full is
// set, so is each neighbour of theirs inside the world (they hold the outer
// apron).
func (ts *Tiles) derivable(b string, z, x, y int, full bool) bool {
	if z < blockLevel || z >= MaxLevel {
		return false
	}
	c := z + 1
	for j := -1; j <= 2; j++ {
		for i := -1; i <= 2; i++ {
			tx, ty := 2*x+i, 2*y+j
			child := i >= 0 && i <= 1 && j >= 0 && j <= 1
			if !child && !full {
				continue
			}
			in := tx >= 0 && ty >= 0 && tx < 1<<c && ty < 1<<c && TileInWorld(c, tx, ty)
			if child && !in {
				return false
			}
			if in && !ts.cache.has(tilePath(b, c, tx, ty)) {
				return false
			}
		}
	}
	return true
}

// derive downsamples tile (z, x, y) from level z+1, each pixel from the 2 x 2
// children's samples it covers:
//   - biome: the mode of the four (ties go to the first in reading order,
//     north-west first), so a biome never appears where none of the four is;
//     a mean of biome indices would be meaningless;
//   - height: the mean, rounded; the pixel's centre is the four samples'
//     centre, so this is the height there, smoothed as a coarser grid should;
//   - forest: the mean, so a forest edge fades as it does on the game's map.
//
// The apron's outer sample needs children's neighbours: from disk when
// they are there, otherwise the nearest sample the children have.
func (ts *Tiles) derive(b string, z, x, y int) ([]byte, error) {
	c := z + 1
	var kids [4][4]*tileData // [row][col] of child tiles 2y-1..2y+2, 2x-1..2x+2
	for j := 0; j < 4; j++ {
		for i := 0; i < 4; i++ {
			tx, ty := 2*x-1+i, 2*y-1+j
			if tx < 0 || ty < 0 || tx >= 1<<c || ty >= 1<<c {
				continue
			}
			body, ok := ts.cache.get(tilePath(b, c, tx, ty))
			if !ok {
				continue
			}
			d, err := decodeServed(body)
			if err != nil {
				continue
			}
			kids[j][i] = d
		}
	}
	flags := uint16(0)
	for j := 1; j <= 2; j++ {
		for i := 1; i <= 2; i++ {
			if kids[j][i] == nil {
				return nil, errors.New("a child tile is missing")
			}
			if j == 1 && i == 1 {
				flags = kids[1][1].flags
			} else if kids[j][i].flags != flags {
				return nil, errors.New("child tiles differ in format")
			}
		}
	}
	n := TileEdge
	// at finds child-level pixel (rx, ry), counted from the first pixel of
	// the north-west child: in whichever loaded tile holds it, else clamped
	// to the children and their aprons.
	at := func(rx, ry int) (*tileData, int) {
		ti, tj := floorDiv(rx, TileSize)+1, floorDiv(ry, TileSize)+1
		if ti >= 0 && ti < 4 && tj >= 0 && tj < 4 && kids[tj][ti] != nil && (kids[tj][ti].flags == flags) {
			return kids[tj][ti], (ry-(tj-1)*TileSize+Apron)*n + rx - (ti-1)*TileSize + Apron
		}
		rx = min(max(rx, -Apron), 2*TileSize+Apron-1)
		ry = min(max(ry, -Apron), 2*TileSize+Apron-1)
		ti = min(max(floorDiv(rx, TileSize), 0), 1) + 1
		tj = min(max(floorDiv(ry, TileSize), 0), 1) + 1
		return kids[tj][ti], (ry-(tj-1)*TileSize+Apron)*n + rx - (ti-1)*TileSize + Apron
	}
	biomes := make([]byte, n*n)
	heights := make([]uint16, n*n)
	var forest []byte
	if flags&1 != 0 {
		forest = make([]byte, n*n)
	}
	for j := 0; j < n; j++ {
		ry := 2 * (j - Apron)
		for i := 0; i < n; i++ {
			rx := 2 * (i - Apron)
			var bs [4]byte
			hsum, fsum := 0, 0
			for s := 0; s < 4; s++ {
				d, k := at(rx+s%2, ry+s/2)
				bs[s] = d.biomes[k]
				hsum += int(d.heights[k])
				if forest != nil {
					fsum += int(d.forest[k])
				}
			}
			o := j*n + i
			biomes[o] = mode4(bs)
			heights[o] = uint16((hsum + 2) / 4)
			if forest != nil {
				forest[o] = byte((fsum + 2) / 4)
			}
		}
	}
	x0, z0, step := TileOrigin(z, x, y)
	raw := encodeTile(n, x0, z0, step, biomes, heights)
	binary.LittleEndian.PutUint16(raw[6:], flags)
	return append(raw, forest...), nil
}

// mode4 is the most common of four values; a tie goes to the earliest.
func mode4(v [4]byte) byte {
	best, bestN := v[0], 0
	for i := 0; i < 4; i++ {
		n := 0
		for k := 0; k < 4; k++ {
			if v[k] == v[i] {
				n++
			}
		}
		if n > bestN {
			best, bestN = v[i], n
		}
	}
	return best
}

func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}
