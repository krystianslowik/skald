// Package terrain turns the grids the skald-terrain Job writes into
// TERRAIN_DIR into one map image. The Job runs the operator's own game
// server's world generator for the world's seed and samples it:
//
//	manifest.json  {"format":1, "seed", "seedHash", "worldGenVersion",
//	                "gameBuild", "resolution", "radius", ...}
//	biomes.u8      resolution^2 bytes, a biome index per pixel (BiomeNames)
//	height.u16le   resolution^2 little-endian uint16, metres = v/50 - 500
//
// Row 0 is north (+z), column 0 is west (-x), each sample at its pixel
// centre, the grid spanning [-radius, radius] on both axes.
//
// The agent checks the grids belong to the current save (seed hash and world
// generator version from the .fwl2) and paints them with its own palette and
// a hillshade, once per cache key (seed hash, world generator version, game
// build, resolution). Terrain for another seed is never served. Grids from
// an older game build are still served but marked stale, so the Job can be
// run again.
package terrain

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/world"
)

// Limits on what the Job may hand over.
const (
	MinRes      = 64
	MaxRes      = 4096
	maxManifest = 64 << 10
	// WaterLevel is the game's sea level in metres.
	WaterLevel = 30.0
	// RefreshEvery is how often Run looks at TERRAIN_DIR and the save.
	RefreshEvery = 30 * time.Second
	// renderVersion is part of the ETag: a new palette invalidates caches.
	renderVersion = "1"
)

// BiomeNames is the index order of biomes.u8.
var BiomeNames = []string{"None", "Meadows", "Swamp", "Mountain", "BlackForest", "Plains", "AshLands", "DeepNorth", "Ocean", "Mistlands"}

// Manifest is manifest.json as the Job writes it. Unknown fields are ignored.
type Manifest struct {
	Format          int     `json:"format"`
	Seed            string  `json:"seed"`
	SeedHash        int32   `json:"seedHash"`
	WorldGenVersion int32   `json:"worldGenVersion"`
	GameBuild       string  `json:"gameBuild"`
	Resolution      int     `json:"resolution"`
	Radius          float64 `json:"radius"`
}

// Key is the cache key: the same key always renders the same image.
type Key struct {
	SeedHash        int32
	WorldGenVersion int32
	GameBuild       string
	Resolution      int
}

func (k Key) build() string {
	sum := sha256.Sum256(fmt.Appendf(nil, "%d|%d|%s|%d|%s", k.SeedHash, k.WorldGenVersion, k.GameBuild, k.Resolution, renderVersion))
	return hex.EncodeToString(sum[:8])
}

// Request is what a terrain run needs to sample this world.
type Request struct {
	SeedName        string `json:"seedName"`
	SeedHash        int32  `json:"seedHash"`
	WorldGenVersion int32  `json:"worldGenVersion"`
	// GameBuild is the running server's version, empty until it is logged.
	GameBuild string `json:"gameBuild"`
}

// Info is GET /state `terrain`.
type Info struct {
	// Enabled: TERRAIN_DIR is set.
	Enabled bool `json:"enabled"`
	// Available: an image for this world can be served.
	Available bool `json:"available"`
	// Stale: a run is due (no grids, another seed, or an older game build).
	Stale bool `json:"stale"`
	// Reason says why it is stale or unavailable: missing, unreadable,
	// world (the save is unreadable), seed, worldGenVersion, gameBuild.
	Reason     string   `json:"reason,omitempty"`
	Build      string   `json:"build,omitempty"`
	Resolution int      `json:"resolution,omitempty"`
	Radius     float64  `json:"radius,omitempty"`
	Request    *Request `json:"request"`
}

// Image is a rendered terrain.
type Image struct {
	PNG        []byte
	ETag       string
	Build      string
	Manifest   Manifest
	RenderedAt time.Time
}

type Options struct {
	// Dir is TERRAIN_DIR; empty turns the feature off (Info still carries the request).
	Dir string
	// Meta returns the current save's metadata; nil when unreadable.
	Meta func() *world.Meta
	// GameVersion returns the running server's version ("l-1.0.17"), "" until known.
	GameVersion func() string
	Logger      *slog.Logger
}

// Terrain watches TERRAIN_DIR and keeps the last good render.
type Terrain struct {
	opt Options

	mu       sync.Mutex
	stamp    stamp
	man      *Manifest
	readErr  error
	img      *Image
	renderMu sync.Mutex
}

type stamp struct {
	mod  time.Time
	size int64
}

func New(opt Options) *Terrain {
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	if opt.Meta == nil {
		opt.Meta = func() *world.Meta { return nil }
	}
	if opt.GameVersion == nil {
		opt.GameVersion = func() string { return "" }
	}
	return &Terrain{opt: opt}
}

// Enabled reports whether TERRAIN_DIR is set.
func (t *Terrain) Enabled() bool { return t != nil && t.opt.Dir != "" }

// Run refreshes every `every` until ctx is done.
func (t *Terrain) Run(ctx context.Context, every time.Duration) {
	if !t.Enabled() {
		return
	}
	tk := time.NewTicker(every)
	defer tk.Stop()
	for {
		if err := t.Refresh(); err != nil {
			t.opt.Logger.Debug("terrain not rendered", "reason", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
		}
	}
}

var errMissing = errors.New("no terrain grids")

// Refresh re-reads the manifest when it changed and renders when its cache
// key differs from the last render. A failed read keeps the last good image.
func (t *Terrain) Refresh() error {
	if !t.Enabled() {
		return errors.New("terrain disabled")
	}
	t.renderMu.Lock()
	defer t.renderMu.Unlock()
	mp := filepath.Join(t.opt.Dir, "manifest.json")
	fi, err := os.Stat(mp)
	if err != nil {
		t.setRead(nil, stamp{}, errMissing)
		return errMissing
	}
	st := stamp{fi.ModTime(), fi.Size()}
	t.mu.Lock()
	same := t.man != nil && t.stamp == st
	img := t.img
	t.mu.Unlock()
	if same && img != nil {
		return nil
	}
	m, err := readManifest(mp)
	if err != nil {
		t.setRead(nil, st, err)
		return err
	}
	key := keyOf(m)
	if img != nil && keyOf(&img.Manifest) == key {
		t.setRead(m, st, nil)
		return nil
	}
	start := time.Now()
	body, err := renderFiles(t.opt.Dir, m)
	if err != nil {
		t.setRead(m, st, err)
		return err
	}
	// The Job may have replaced the files during the render: keep nothing then.
	if fi2, err := os.Stat(mp); err != nil || fi2.ModTime() != st.mod || fi2.Size() != st.size {
		return errors.New("terrain changed during the render; retrying")
	}
	b := key.build()
	t.mu.Lock()
	t.man, t.stamp, t.readErr = m, st, nil
	t.img = &Image{PNG: body, ETag: `"t-` + b + `"`, Build: b, Manifest: *m, RenderedAt: time.Now().UTC()}
	t.mu.Unlock()
	t.opt.Logger.Info("terrain rendered", "build", b, "resolution", m.Resolution, "gameBuild", m.GameBuild, "bytes", len(body), "seconds", time.Since(start).Seconds())
	return nil
}

func (t *Terrain) setRead(m *Manifest, st stamp, err error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.man, t.stamp, t.readErr = m, st, err
}

func keyOf(m *Manifest) Key {
	return Key{SeedHash: m.SeedHash, WorldGenVersion: m.WorldGenVersion, GameBuild: m.GameBuild, Resolution: m.Resolution}
}

func readManifest(p string) (*Manifest, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxManifest+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxManifest {
		return nil, errors.New("manifest.json too large")
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("manifest.json: %w", err)
	}
	if m.Format != 1 {
		return nil, fmt.Errorf("manifest.json: unknown format %d", m.Format)
	}
	if m.Resolution < MinRes || m.Resolution > MaxRes {
		return nil, fmt.Errorf("manifest.json: resolution %d outside %d..%d", m.Resolution, MinRes, MaxRes)
	}
	if !(m.Radius >= 1000 && m.Radius <= 20000) {
		return nil, fmt.Errorf("manifest.json: radius %v", m.Radius)
	}
	if len(m.GameBuild) > 64 || len(m.Seed) > 256 {
		return nil, errors.New("manifest.json: oversized field")
	}
	return &m, nil
}

// status compares the grids with the save and the running game.
func (t *Terrain) status() (Info, *Image) {
	meta := t.opt.Meta()
	info := Info{Enabled: t.Enabled()}
	if meta != nil {
		info.Request = &Request{SeedName: meta.SeedName, SeedHash: meta.Seed, WorldGenVersion: meta.WorldGenVersion, GameBuild: t.opt.GameVersion()}
	}
	if !info.Enabled {
		return info, nil
	}
	t.mu.Lock()
	readErr, img := t.readErr, t.img
	t.mu.Unlock()
	// A failed read keeps the last good image; without one there is nothing to show.
	if img == nil {
		info.Stale, info.Reason = true, "missing"
		if readErr != nil && !errors.Is(readErr, errMissing) {
			info.Reason = "unreadable"
		}
		return info, nil
	}
	m := img.Manifest
	switch {
	case meta == nil:
		// Without the save there is nothing to check the seed against.
		info.Reason = "world"
		return info, nil
	case m.SeedHash != meta.Seed:
		info.Stale, info.Reason = true, "seed"
		return info, nil
	case m.WorldGenVersion != meta.WorldGenVersion:
		info.Stale, info.Reason = true, "worldGenVersion"
		return info, nil
	}
	info.Available, info.Build, info.Resolution, info.Radius = true, img.Build, m.Resolution, m.Radius
	// An empty version means the agent has not seen the server's version line
	// yet (it started later): not a reason to run again.
	if v := t.opt.GameVersion(); v != "" && v != m.GameBuild {
		info.Stale, info.Reason = true, "gameBuild"
	}
	return info, img
}

// Info is the /state summary.
func (t *Terrain) Info() *Info {
	if t == nil {
		return nil
	}
	i, _ := t.status()
	return &i
}

// Current returns the image when it belongs to the current save.
func (t *Terrain) Current() (*Image, *Info) {
	if t == nil {
		return nil, nil
	}
	i, img := t.status()
	return img, &i
}

// --- rendering -------------------------------------------------------------

const (
	shades     = 7
	depths     = 8
	firstWater = 1 + 10*shades
	// exaggeration makes gentle relief readable at ~10 m per pixel.
	exaggeration = 2.5
)

// Palette entries: 0 transparent (beyond the world's edge), then every biome
// at `shades` light levels, then `depths` water depths. The colours are our
// own: muted so the parchment shows through when the web multiplies them.
var biomeRGB = [10][3]float64{
	{128, 116, 92},  // None
	{156, 172, 92},  // Meadows
	{118, 102, 72},  // Swamp
	{226, 226, 230}, // Mountain
	{78, 102, 64},   // BlackForest
	{208, 188, 116}, // Plains
	{150, 66, 48},   // AshLands
	{206, 220, 232}, // DeepNorth
	{92, 120, 136},  // Ocean (above water: rare)
	{112, 98, 124},  // Mistlands
}

var waterShallow = [3]float64{116, 156, 164}
var waterDeep = [3]float64{38, 66, 92}

// depthEdges are the lower bounds (metres below sea level) of each depth step.
var depthEdges = [depths]float64{0, 2, 5, 10, 20, 35, 55, 80}

// Palette is the PNG palette, exported for tests.
var Palette = buildPalette()

func shadeFactor(s int) float64 { return 0.62 + float64(s)*(0.68/float64(shades-1)) }

func buildPalette() color.Palette {
	p := make(color.Palette, 0, firstWater+depths)
	p = append(p, color.NRGBA{})
	for b := range biomeRGB {
		for s := 0; s < shades; s++ {
			f := shadeFactor(s)
			c := biomeRGB[b]
			p = append(p, color.NRGBA{clamp8(c[0] * f), clamp8(c[1] * f), clamp8(c[2] * f), 255})
		}
	}
	for d := 0; d < depths; d++ {
		k := float64(d) / float64(depths-1)
		p = append(p, color.NRGBA{
			clamp8(waterShallow[0] + (waterDeep[0]-waterShallow[0])*k),
			clamp8(waterShallow[1] + (waterDeep[1]-waterShallow[1])*k),
			clamp8(waterShallow[2] + (waterDeep[2]-waterShallow[2])*k),
			255,
		})
	}
	return p
}

func clamp8(v float64) uint8 {
	return uint8(math.Max(0, math.Min(255, math.Round(v))))
}

// The light comes from the north-west, 45 degrees up, like most maps.
var lightX, lightZ, lightY = -0.5, 0.5, math.Sqrt2 / 2

func shadeIndex(dhdx, dhdz float64) int {
	nx, nz, ny := -dhdx*exaggeration, -dhdz*exaggeration, 1.0
	l := math.Sqrt(nx*nx + nz*nz + ny*ny)
	v := (nx*lightX + nz*lightZ + ny*lightY) / l / lightY
	s := int(math.Round((v - 0.62) / (0.68 / float64(shades-1))))
	return min(shades-1, max(0, s))
}

func depthIndex(depth float64) int {
	d := 0
	for i, e := range depthEdges {
		if depth >= e {
			d = i
		}
	}
	return d
}

func renderFiles(dir string, m *Manifest) ([]byte, error) {
	n := m.Resolution
	bf, err := openSized(filepath.Join(dir, "biomes.u8"), int64(n)*int64(n))
	if err != nil {
		return nil, err
	}
	defer bf.Close()
	hf, err := openSized(filepath.Join(dir, "height.u16le"), 2*int64(n)*int64(n))
	if err != nil {
		return nil, err
	}
	defer hf.Close()
	img, err := Render(bufio.NewReaderSize(bf, 1<<16), bufio.NewReaderSize(hf, 1<<17), n, m.Radius)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func openSized(p string, want int64) (*os.File, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() != want {
		f.Close()
		return nil, fmt.Errorf("%s: want %d bytes", filepath.Base(p), want)
	}
	return f, nil
}

// Render paints the grids, north up, into a paletted image of n x n. It
// streams the heights with a three-row window, so memory stays at the image
// plus a few rows whatever the resolution.
func Render(biomes, height io.Reader, n int, radius float64) (*image.Paletted, error) {
	if n < 2 {
		return nil, errors.New("resolution too small")
	}
	img := image.NewPaletted(image.Rect(0, 0, n, n), Palette)
	step := 2 * radius / float64(n)
	raw := make([]byte, 2*n)
	readRow := func(dst []float64) error {
		if _, err := io.ReadFull(height, raw); err != nil {
			return err
		}
		for i := range dst {
			dst[i] = float64(binary.LittleEndian.Uint16(raw[2*i:]))/50 - 500
		}
		return nil
	}
	prev, cur, next := make([]float64, n), make([]float64, n), make([]float64, n)
	if err := readRow(cur); err != nil {
		return nil, fmt.Errorf("height: %w", err)
	}
	copy(prev, cur)
	brow := make([]byte, n)
	r2 := radius * radius
	for row := 0; row < n; row++ {
		if row+1 < n {
			if err := readRow(next); err != nil {
				return nil, fmt.Errorf("height: %w", err)
			}
		} else {
			copy(next, cur)
		}
		if _, err := io.ReadFull(biomes, brow); err != nil {
			return nil, fmt.Errorf("biomes: %w", err)
		}
		z := radius - (float64(row)+0.5)*step
		out := img.Pix[row*img.Stride : row*img.Stride+n]
		for col := 0; col < n; col++ {
			x := -radius + (float64(col)+0.5)*step
			if x*x+z*z > r2 {
				out[col] = 0
				continue
			}
			h := cur[col]
			if h < WaterLevel {
				out[col] = uint8(firstWater + depthIndex(WaterLevel-h))
				continue
			}
			b := int(brow[col])
			if b >= len(biomeRGB) {
				b = 0
			}
			l, r := max(0, col-1), min(n-1, col+1)
			dhdx := (cur[r] - cur[l]) / (float64(r-l) * step)
			// Row above is north: +z.
			dhdz := (prev[col] - next[col]) / (2 * step)
			out[col] = uint8(1 + b*shades + shadeIndex(dhdx, dhdz))
		}
		prev, cur, next = cur, next, prev
	}
	return img, nil
}
