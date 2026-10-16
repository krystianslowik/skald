package terrain

// The terrain as a tile pyramid, sampled from the running server through
// the bridge plugin and cached on disk. Level z splits the world's square
// [-WorldRadius, WorldRadius]^2 into 2^z x 2^z tiles of TileSize pixels, so
// level 3 is 2048 px across: exactly the terrain Job's default grid, which
// fills levels 0..3 without the bridge when it is there and current. Every
// tile carries a two-sample apron on each side (TileEdge samples a row), so
// the web can shade and smooth its edges without the neighbours.
//
// A tile is the bridge's binary format (bridge/plugin/TerrainTile.cs),
// gzipped; grid tiles use the same format without the forest channel. The
// web decodes and paints them in a worker.

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/bridge"
)

const (
	TileSize = 256
	TileEdge = TileSize + 2*Apron
	// Apron is the samples around a tile on every side: two, so a slope at
	// the tile's edge is a centred difference in both neighbours.
	Apron = 2
	// MaxLevel is 0.64 m per pixel; deeper adds little but bridge time.
	MaxLevel = 7
	// WorldRadius is half the pyramid's span: the game world's edge.
	WorldRadius = 10500.0
	// tileFormat is part of the build id: a format change refetches everything.
	tileFormat = "1"
	tileMagic  = 0x31544B53
	tileHeader = 24
	// DefaultCacheBytes bounds the disk cache when TERRAIN_CACHE_MB is unset.
	DefaultCacheBytes = 256 << 20
	// infoEvery is how long the bridge's world facts are trusted.
	infoEvery = time.Minute
	infoRetry = 15 * time.Second
)

// MetresPerPixel is the pyramid's resolution at level z.
func MetresPerPixel(z int) float64 { return 2 * WorldRadius / float64(int(TileSize)<<z) }

// TileOrigin is the world position of a tile's north-west apron sample:
// pixel (i, j) of the tile (apron excluded) is centred at
// x0 + (i+Apron)*step, z0 - (j+Apron)*step.
func TileOrigin(z, x, y int) (x0, z0, step float64) {
	step = MetresPerPixel(z)
	x0 = -WorldRadius + (float64(x*TileSize-Apron)+0.5)*step
	z0 = WorldRadius - (float64(y*TileSize-Apron)+0.5)*step
	return
}

// TileInWorld reports whether a tile touches the world disc.
func TileInWorld(z, x, y int) bool {
	span := 2 * WorldRadius / float64(int(1)<<z)
	west, east := -WorldRadius+float64(x)*span, -WorldRadius+float64(x+1)*span
	north, south := WorldRadius-float64(y)*span, WorldRadius-float64(y+1)*span
	// The tile's point nearest the centre.
	nx := math.Max(west, math.Min(0, east))
	nz := math.Max(south, math.Min(0, north))
	return nx*nx+nz*nz < WorldRadius*WorldRadius
}

// Source is the bridge plugin's terrain sampler (implemented by bridge.Client).
type Source interface {
	TerrainInfo(ctx context.Context) (*bridge.TerrainInfo, error)
	TerrainTile(ctx context.Context, n int, x0, z0, step float64) ([]byte, int, error)
}

// TileOptions configures the pyramid.
type TileOptions struct {
	// Source is the bridge; nil serves the grid levels only.
	Source Source
	// CacheDir keeps tiles across restarts; "" or an unwritable one keeps them in memory.
	CacheDir string
	// CacheBytes bounds the cache; DefaultCacheBytes when zero.
	CacheBytes int64
	Logger     *slog.Logger
}

// Tiles serves the pyramid.
type Tiles struct {
	t     *Terrain
	opt   TileOptions
	cache *tileCache

	mu      sync.Mutex
	info    *bridge.TerrainInfo
	infoAt  time.Time
	infoErr error
	flight  map[string]*tileCall
	// sem lets one bridge call run at a time: the plugin samples one tile
	// at a time anyway, and a queue here is cheaper than 429s there.
	sem chan struct{}

	// Counters for /metrics.
	stats TileStats
}

type tileCall struct {
	done chan struct{}
	body []byte
	err  error
}

// NewTiles builds the pyramid over t's grid and opt.Source.
func NewTiles(t *Terrain, opt TileOptions) *Tiles {
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	if opt.CacheBytes <= 0 {
		opt.CacheBytes = DefaultCacheBytes
	}
	c, err := openTileCache(opt.CacheDir, opt.CacheBytes)
	if err != nil {
		opt.Logger.Info("terrain tile cache in memory only", "dir", opt.CacheDir, "reason", err.Error())
		c, _ = openTileCache("", min(opt.CacheBytes, 64<<20))
	}
	return &Tiles{t: t, opt: opt, cache: c, flight: map[string]*tileCall{}, sem: make(chan struct{}, 1)}
}

// TilesDoc is GET /terrain/tiles.json.
type TilesDoc struct {
	// Build names everything a tile depends on; tile URLs carry it.
	Build     string  `json:"build"`
	TileSize  int     `json:"tileSize"`
	Apron     int     `json:"apron"`
	MaxLevel  int     `json:"maxLevel"`
	GridLevel int     `json:"gridLevel"`
	Radius    float64 `json:"radius"`
	// Source: "bridge" (the running server) or "grid" (the terrain Job only).
	Source     string   `json:"source"`
	Stale      bool     `json:"stale"`
	WaterLevel float64  `json:"waterLevel"`
	Biomes     []string `json:"biomes"`
	// Forest: "mask" (the game's minimap mask), "factor" (the raw forest
	// factor) or "none" in bridge tiles.
	Forest  string                 `json:"forest"`
	Palette *bridge.TerrainPalette `json:"palette,omitempty"`
}

type tileKey struct {
	SeedHash        int32
	WorldGenVersion int32
	GameBuild       string
}

func (k tileKey) build() string {
	sum := sha256.Sum256(fmt.Appendf(nil, "tiles|%s|%d|%d|%s", tileFormat, k.SeedHash, k.WorldGenVersion, k.GameBuild))
	return hex.EncodeToString(sum[:8])
}

// plan is what the pyramid can serve right now.
type plan struct {
	doc  TilesDoc
	key  tileKey
	grid *Manifest // usable grid for levels <= gridLevel, nil if none
}

var errNoTerrain = errors.New("no terrain for this world")

// gridLevel is the level a grid fills one to one, or -1 when it cannot back tiles.
func gridLevel(m *Manifest) int {
	if m == nil || m.Radius != WorldRadius {
		return -1
	}
	for z := 0; z <= MaxLevel; z++ {
		if TileSize<<z == m.Resolution {
			return z
		}
	}
	return -1
}

func (ts *Tiles) bridgeInfo(ctx context.Context) (*bridge.TerrainInfo, error) {
	if ts.opt.Source == nil {
		return nil, errNoTerrain
	}
	ts.mu.Lock()
	info, at, ierr := ts.info, ts.infoAt, ts.infoErr
	ts.mu.Unlock()
	fresh := infoEvery
	if ierr != nil {
		fresh = infoRetry
	}
	if !at.IsZero() && time.Since(at) < fresh {
		return info, ierr
	}
	info, ierr = ts.opt.Source.TerrainInfo(ctx)
	if ierr == nil && info.Forest == "" {
		info.Forest = "none"
	}
	ts.mu.Lock()
	ts.info, ts.infoAt, ts.infoErr = info, time.Now(), ierr
	ts.mu.Unlock()
	return info, ierr
}

func (ts *Tiles) plan(ctx context.Context) (*plan, error) {
	var gm *Manifest
	var ginfo *Info
	if ts.t != nil {
		if img, i := ts.t.Current(); img != nil && i != nil && i.Available {
			m := img.Manifest
			gm, ginfo = &m, i
		}
	}
	gl := gridLevel(gm)
	if info, err := ts.bridgeInfo(ctx); err == nil {
		k := tileKey{info.SeedHash, info.WorldGenVersion, info.GameBuild}
		p := &plan{key: k, doc: TilesDoc{
			Build: k.build(), TileSize: TileSize, Apron: Apron, MaxLevel: MaxLevel, GridLevel: -1, Radius: WorldRadius,
			Source: "bridge", WaterLevel: WaterLevel, Biomes: BiomeNames, Forest: info.Forest, Palette: &info.Palette,
		}}
		// The grid serves its levels only when it is from exactly this world and build.
		if gl >= 0 && gm.SeedHash == k.SeedHash && gm.WorldGenVersion == k.WorldGenVersion && gm.GameBuild == k.GameBuild {
			p.grid, p.doc.GridLevel = gm, gl
		}
		return p, nil
	}
	if gl < 0 {
		return nil, errNoTerrain
	}
	k := tileKey{gm.SeedHash, gm.WorldGenVersion, gm.GameBuild}
	return &plan{key: k, grid: gm, doc: TilesDoc{
		Build: k.build(), TileSize: TileSize, Apron: Apron, MaxLevel: gl, GridLevel: gl, Radius: WorldRadius,
		Source: "grid", Stale: ginfo.Stale, WaterLevel: WaterLevel, Biomes: BiomeNames, Forest: "none",
	}}, nil
}

// Doc is what the web needs to ask for tiles; errNoTerrain when there is none.
func (ts *Tiles) Doc(ctx context.Context) (*TilesDoc, error) {
	p, err := ts.plan(ctx)
	if err != nil {
		return nil, err
	}
	d := p.doc
	return &d, nil
}

// TileError carries the HTTP status for a refused tile.
type TileError struct {
	Status  int
	Message string
}

func (e *TileError) Error() string { return e.Message }

// Tile returns tile (z, x, y) of build `build` ("" for the current one),
// gzipped, and the build it belongs to.
func (ts *Tiles) Tile(ctx context.Context, z, x, y int, build string) ([]byte, string, error) {
	p, err := ts.plan(ctx)
	if err != nil {
		return nil, "", &TileError{http.StatusNotFound, err.Error()}
	}
	b := p.doc.Build
	if build != "" && build != b {
		return nil, b, &TileError{http.StatusNotFound, "terrain build changed"}
	}
	if z < 0 || z > p.doc.MaxLevel || x < 0 || y < 0 || x >= 1<<z || y >= 1<<z {
		return nil, b, &TileError{http.StatusNotFound, "no such tile"}
	}
	if !TileInWorld(z, x, y) {
		return nil, b, &TileError{http.StatusNotFound, "outside the world"}
	}
	key := fmt.Sprintf("%s/%d/%d-%d.skt.gz", b, z, x, y)
	if body, ok := ts.cache.get(key); ok {
		ts.count(&ts.stats.Hits)
		return body, b, nil
	}
	ts.count(&ts.stats.Misses)
	ts.mu.Lock()
	c, busy := ts.flight[key]
	if !busy {
		c = &tileCall{done: make(chan struct{})}
		ts.flight[key] = c
	}
	ts.mu.Unlock()
	if !busy {
		// Detached from this request: a viewer who scrolls away should not
		// waste a tile someone else (or the next pan) asks for again.
		go ts.produce(c, key, p, z, x, y)
	}
	select {
	case <-c.done:
		return c.body, b, c.err
	case <-ctx.Done():
		return nil, b, ctx.Err()
	}
}

func (ts *Tiles) count(n *uint64) {
	ts.mu.Lock()
	*n++
	ts.mu.Unlock()
}

func (ts *Tiles) produce(c *tileCall, key string, p *plan, z, x, y int) {
	defer func() {
		ts.mu.Lock()
		delete(ts.flight, key)
		ts.mu.Unlock()
		close(c.done)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*bridge.TerrainTimeout)
	defer cancel()
	var raw []byte
	var err error
	if p.grid != nil && z <= p.doc.GridLevel {
		raw, err = gridTile(ts.t.opt.Dir, p.grid, p.doc.GridLevel, z, x, y)
		if err == nil {
			ts.count(&ts.stats.GridTiles)
		}
	} else if ts.opt.Source != nil {
		raw, err = ts.bridgeTile(ctx, z, x, y)
	} else {
		err = &TileError{http.StatusNotFound, "no source for this level"}
	}
	if err != nil {
		ts.count(&ts.stats.Errors)
		ts.opt.Logger.Debug("terrain tile failed", "z", z, "x", x, "y", y, "err", err.Error())
		c.err = err
		return
	}
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(packHeights(raw))
	_ = zw.Close()
	c.body = buf.Bytes()
	if err := ts.cache.put(key, c.body); err != nil {
		ts.opt.Logger.Debug("terrain tile not cached", "key", key, "err", err.Error())
	}
}

func (ts *Tiles) bridgeTile(ctx context.Context, z, x, y int) ([]byte, error) {
	x0, z0, step := TileOrigin(z, x, y)
	for attempt := 0; ; attempt++ {
		select {
		case ts.sem <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		body, ms, err := ts.opt.Source.TerrainTile(ctx, TileEdge, x0, z0, step)
		<-ts.sem
		if err == nil {
			if err := checkTile(body, TileEdge); err != nil {
				return nil, &TileError{http.StatusBadGateway, err.Error()}
			}
			ts.mu.Lock()
			ts.stats.BridgeTiles++
			ts.stats.BridgeMs += uint64(max(0, ms))
			ts.mu.Unlock()
			return body, nil
		}
		// Busy or rate-limited: back off and queue again, a few times.
		if bridge.StatusOf(err) == http.StatusTooManyRequests && attempt < 5 {
			select {
			case <-time.After(time.Duration(250*(attempt+1)) * time.Millisecond):
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		status := bridge.StatusOf(err)
		if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
			// Ask the world facts again: the bridge may be gone or the world reloading.
			ts.mu.Lock()
			ts.infoAt = time.Time{}
			ts.mu.Unlock()
		}
		return nil, &TileError{status, err.Error()}
	}
}

// checkTile validates the bridge's answer before it is cached for good.
func checkTile(b []byte, n int) error {
	if len(b) < tileHeader || binary.LittleEndian.Uint32(b) != tileMagic || binary.LittleEndian.Uint16(b[4:]) != 1 {
		return errors.New("not a terrain tile")
	}
	flags := binary.LittleEndian.Uint16(b[6:])
	if int(binary.LittleEndian.Uint32(b[8:])) != n {
		return errors.New("terrain tile of the wrong size")
	}
	per := 3
	if flags&1 != 0 {
		per = 4
	}
	if len(b) != tileHeader+n*n*per {
		return errors.New("terrain tile truncated")
	}
	return nil
}

// flagPacked marks heights stored as row deltas in two byte planes.
const flagPacked = 4

// packHeights rewrites a tile's heights for gzip: each row as differences
// from the sample to its west (mod 2^16), low bytes of the whole grid first,
// then the high bytes. Smooth terrain then compresses to about half. The web
// undoes it (terrainpaint.ts decodeTile); flagPacked says it was done.
func packHeights(raw []byte) []byte {
	n := int(binary.LittleEndian.Uint32(raw[8:]))
	nn := n * n
	out := append([]byte(nil), raw...)
	binary.LittleEndian.PutUint16(out[6:], binary.LittleEndian.Uint16(raw[6:])|flagPacked)
	src := raw[tileHeader+nn:]
	lo := out[tileHeader+nn : tileHeader+2*nn]
	hi := out[tileHeader+2*nn : tileHeader+3*nn]
	for r := 0; r < n; r++ {
		var prev uint16
		for c := 0; c < n; c++ {
			i := r*n + c
			v := binary.LittleEndian.Uint16(src[2*i:])
			d := v - prev
			prev = v
			lo[i], hi[i] = byte(d), byte(d>>8)
		}
	}
	return out
}

// encodeTile writes the bridge's format: header, biomes, heights[, forest].
func encodeTile(n int, x0, z0, step float64, biomes []byte, heights []uint16) []byte {
	out := make([]byte, tileHeader+n*n*3)
	binary.LittleEndian.PutUint32(out, tileMagic)
	binary.LittleEndian.PutUint16(out[4:], 1)
	binary.LittleEndian.PutUint16(out[6:], 0)
	binary.LittleEndian.PutUint32(out[8:], uint32(n))
	binary.LittleEndian.PutUint32(out[12:], math.Float32bits(float32(x0)))
	binary.LittleEndian.PutUint32(out[16:], math.Float32bits(float32(z0)))
	binary.LittleEndian.PutUint32(out[20:], math.Float32bits(float32(step)))
	copy(out[tileHeader:], biomes)
	h := out[tileHeader+n*n:]
	for i, v := range heights {
		binary.LittleEndian.PutUint16(h[2*i:], v)
	}
	return out
}

// gridTile cuts tile (z, x, y) out of the Job's grid, which fills level gl
// one to one: each pixel at level z covers k x k grid pixels (k = 2^(gl-z)),
// heights averaged, biome by majority. Apron pixels past the grid's edge
// repeat the edge.
func gridTile(dir string, m *Manifest, gl, z, x, y int) ([]byte, error) {
	res := m.Resolution
	k := 1 << (gl - z)
	px := TileSize << z // pixels across at level z
	// Grid rows this tile needs, apron included.
	r0 := max(0, (y*TileSize-Apron)*k)
	r1 := min(res, (y*TileSize+TileSize+Apron)*k)
	rows := r1 - r0
	bf, err := os.Open(filepath.Join(dir, "biomes.u8"))
	if err != nil {
		return nil, err
	}
	defer bf.Close()
	hf, err := os.Open(filepath.Join(dir, "height.u16le"))
	if err != nil {
		return nil, err
	}
	defer hf.Close()
	bio := make([]byte, rows*res)
	if _, err := bf.ReadAt(bio, int64(r0)*int64(res)); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	hraw := make([]byte, 2*rows*res)
	if _, err := hf.ReadAt(hraw, 2*int64(r0)*int64(res)); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	n := TileEdge
	biomes := make([]byte, n*n)
	heights := make([]uint16, n*n)
	var votes [256]int
	for j := 0; j < n; j++ {
		pr := min(px-1, max(0, y*TileSize+j-Apron))
		for i := 0; i < n; i++ {
			pc := min(px-1, max(0, x*TileSize+i-Apron))
			sum := 0
			best, bestN := byte(0), 0
			for dr := 0; dr < k; dr++ {
				row := pr*k + dr - r0
				for dc := 0; dc < k; dc++ {
					g := row*res + pc*k + dc
					sum += int(binary.LittleEndian.Uint16(hraw[2*g:]))
					b := bio[g]
					votes[b]++
					if votes[b] > bestN {
						best, bestN = b, votes[b]
					}
				}
			}
			for dr := 0; dr < k; dr++ {
				row := pr*k + dr - r0
				for dc := 0; dc < k; dc++ {
					votes[bio[row*res+pc*k+dc]] = 0
				}
			}
			biomes[j*n+i] = best
			heights[j*n+i] = uint16((sum + k*k/2) / (k * k))
		}
	}
	x0, z0, step := TileOrigin(z, x, y)
	return encodeTile(n, x0, z0, step, biomes, heights), nil
}

// TileStats are the pyramid's counters since the agent started.
type TileStats struct {
	Hits, Misses, BridgeTiles, GridTiles, BridgeMs, Errors uint64
	CacheBytes                                             int64
	CacheTiles                                             int
}

// Stats is a snapshot of the counters, for /metrics.
func (ts *Tiles) Stats() TileStats {
	ts.mu.Lock()
	s := ts.stats
	ts.mu.Unlock()
	s.CacheBytes, s.CacheTiles = ts.cache.size()
	return s
}
