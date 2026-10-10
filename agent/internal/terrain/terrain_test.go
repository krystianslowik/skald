package terrain

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/world"
)

// grids builds a synthetic n x n world: the north half Meadows at 60 m with a
// ridge rising to the east, the south half sea at 0 m.
func grids(n int) (biomes, height []byte) {
	biomes = make([]byte, n*n)
	height = make([]byte, 2*n*n)
	for row := 0; row < n; row++ {
		for col := 0; col < n; col++ {
			i := row*n + col
			h := 0.0
			if row < n/2 {
				biomes[i] = 1 // Meadows
				h = 60 + float64(col)*0.5
			} else {
				biomes[i] = 8 // Ocean
			}
			binary.LittleEndian.PutUint16(height[2*i:], uint16((h+500)*50))
		}
	}
	return
}

func writeRun(t *testing.T, dir string, m Manifest, n int) {
	t.Helper()
	b, h := grids(n)
	if err := os.WriteFile(filepath.Join(dir, "biomes.u8"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "height.u16le"), h, 0o644); err != nil {
		t.Fatal(err)
	}
	doc, _ := json.Marshal(m)
	// Extra fields the Job writes are ignored.
	doc = append(doc[:len(doc)-1], []byte(`,"elapsedMs":8000,"threads":4}`)...)
	p := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(p, doc, 0o644); err != nil {
		t.Fatal(err)
	}
	// The stat cache keys on mtime: make every write distinct.
	later := time.Now().Add(time.Duration(len(doc)) * time.Millisecond)
	_ = os.Chtimes(p, later, later)
}

var good = Manifest{Format: 1, Seed: "SynthSeed", SeedHash: 4242, WorldGenVersion: 2, GameBuild: "l-1.0.17", Resolution: 64, Radius: 10500}

func newTerrain(dir string, meta *world.Meta, version *string) *Terrain {
	return New(Options{
		Dir:         dir,
		Meta:        func() *world.Meta { return meta },
		GameVersion: func() string { return *version },
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

func TestRenderOrientationWaterAndEdge(t *testing.T) {
	n := 64
	b, h := grids(n)
	img, err := Render(bytes.NewReader(b), bytes.NewReader(h), n, 10500)
	if err != nil {
		t.Fatal(err)
	}
	at := func(col, row int) uint8 { return img.Pix[row*img.Stride+col] }
	// Row 0 is north: land there, water in the south, nothing past the world's edge.
	if c := at(n/2, 2); c < 1 || c >= firstWater || (int(c)-1)/shades != 1 {
		t.Errorf("north centre = %d, want a Meadows shade", c)
	}
	if c := at(n/2, n-3); c < firstWater {
		t.Errorf("south centre = %d, want water", c)
	}
	if c := at(0, 0); c != 0 {
		t.Errorf("corner = %d, want transparent", c)
	}
	if _, _, _, a := Palette[0].RGBA(); a != 0 {
		t.Error("palette 0 must be transparent")
	}
	if len(Palette) > 256 {
		t.Errorf("palette has %d colours", len(Palette))
	}
}

func TestShadeFollowsTheLight(t *testing.T) {
	flat := shadeIndex(0, 0)
	// A slope rising to the east faces west, towards the north-west light.
	towards := shadeIndex(0.4, 0)
	away := shadeIndex(-0.4, 0)
	if !(towards > flat && flat > away) {
		t.Errorf("shades: towards %d, flat %d, away %d", towards, flat, away)
	}
	if depthIndex(0.5) != 0 || depthIndex(100) != depths-1 {
		t.Error("depth steps")
	}
}

func TestRenderRejectsShortGrids(t *testing.T) {
	b, h := grids(64)
	if _, err := Render(bytes.NewReader(b[:100]), bytes.NewReader(h), 64, 10500); err == nil {
		t.Error("short biomes accepted")
	}
	if _, err := Render(bytes.NewReader(b), bytes.NewReader(h[:1000]), 64, 10500); err == nil {
		t.Error("short heights accepted")
	}
}

func TestRefreshMatchesTheSave(t *testing.T) {
	dir := t.TempDir()
	meta := &world.Meta{SeedName: "SynthSeed", Seed: 4242, WorldGenVersion: 2}
	version := "l-1.0.17"
	tr := newTerrain(dir, meta, &version)

	// Nothing yet: a run is due, and the request says for what.
	if err := tr.Refresh(); err == nil {
		t.Error("refresh without grids succeeded")
	}
	i := tr.Info()
	if i.Available || !i.Stale || i.Reason != "missing" || i.Request == nil || i.Request.SeedHash != 4242 || i.Request.SeedName != "SynthSeed" || i.Request.GameBuild != "l-1.0.17" {
		t.Fatalf("info before = %+v (request %+v)", i, i.Request)
	}

	writeRun(t, dir, good, 64)
	if err := tr.Refresh(); err != nil {
		t.Fatal(err)
	}
	img, info := tr.Current()
	if img == nil || !info.Available || info.Stale || info.Build == "" || info.Resolution != 64 {
		t.Fatalf("after run: %+v", info)
	}
	dec, err := png.Decode(bytes.NewReader(img.PNG))
	if err != nil || dec.Bounds().Dx() != 64 || dec.Bounds().Dy() != 64 {
		t.Fatalf("png: %v %v", err, dec)
	}
	etag := img.ETag

	// Unchanged files: no new render. The same key again: the same ETag.
	if err := tr.Refresh(); err != nil {
		t.Fatal(err)
	}
	if img2, _ := tr.Current(); img2 != img {
		t.Error("rendered again without a change")
	}
	writeRun(t, dir, good, 64)
	_ = tr.Refresh()
	if img2, _ := tr.Current(); img2.ETag != etag {
		t.Error("same cache key, different ETag")
	}

	// The server updated: still shown, but due for a run.
	version = "l-1.0.18"
	if i := tr.Info(); !i.Available || !i.Stale || i.Reason != "gameBuild" {
		t.Errorf("after a game update = %+v", i)
	}
	// Unknown version (agent started after the version line): not stale.
	version = ""
	if i := tr.Info(); !i.Available || i.Stale {
		t.Errorf("unknown version = %+v", i)
	}

	// Another seed: never served.
	meta.Seed = 99
	if img, i := tr.Current(); img != nil || i.Available || !i.Stale || i.Reason != "seed" {
		t.Errorf("other seed = %v %+v", img != nil, i)
	}
	meta.Seed = 4242
	meta.WorldGenVersion = 1
	if img, i := tr.Current(); img != nil || i.Reason != "worldGenVersion" {
		t.Errorf("other generator = %v %+v", img != nil, i)
	}
	meta.WorldGenVersion = 2

	// A new run for a newer build renders a new image with a new ETag.
	m := good
	m.GameBuild = "l-1.0.18"
	writeRun(t, dir, m, 64)
	if err := tr.Refresh(); err != nil {
		t.Fatal(err)
	}
	if img3, _ := tr.Current(); img3.ETag == etag || img3.Manifest.GameBuild != "l-1.0.18" {
		t.Error("a newer build kept the old render")
	}
}

func TestRefreshKeepsTheLastGoodImage(t *testing.T) {
	dir := t.TempDir()
	meta := &world.Meta{Seed: 4242, WorldGenVersion: 2}
	version := ""
	tr := newTerrain(dir, meta, &version)
	writeRun(t, dir, good, 64)
	if err := tr.Refresh(); err != nil {
		t.Fatal(err)
	}
	// A half-written run: the manifest says 128 but the grids are 64.
	m := good
	m.Resolution = 128
	doc, _ := json.Marshal(m)
	p := filepath.Join(dir, "manifest.json")
	_ = os.WriteFile(p, doc, 0o644)
	later := time.Now().Add(5 * time.Second)
	_ = os.Chtimes(p, later, later)
	if err := tr.Refresh(); err == nil {
		t.Error("mismatched grids accepted")
	}
	if img, i := tr.Current(); img == nil || !i.Available || img.Manifest.Resolution != 64 {
		t.Errorf("last good image lost: %+v", i)
	}
}

func TestManifestValidation(t *testing.T) {
	dir := t.TempDir()
	for name, doc := range map[string]string{
		"format":     `{"format":2,"seedHash":1,"worldGenVersion":2,"gameBuild":"x","resolution":64,"radius":10500}`,
		"resolution": `{"format":1,"seedHash":1,"worldGenVersion":2,"gameBuild":"x","resolution":8192,"radius":10500}`,
		"radius":     `{"format":1,"seedHash":1,"worldGenVersion":2,"gameBuild":"x","resolution":64,"radius":5}`,
		"json":       `{"format":1,`,
	} {
		p := filepath.Join(dir, name+".json")
		_ = os.WriteFile(p, []byte(doc), 0o644)
		if _, err := readManifest(p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDisabledStillCarriesTheRequest(t *testing.T) {
	version := "l-1.0.17"
	tr := newTerrain("", &world.Meta{SeedName: "S", Seed: 7, WorldGenVersion: 2}, &version)
	i := tr.Info()
	if i.Enabled || i.Available || i.Request == nil || i.Request.SeedHash != 7 {
		t.Errorf("disabled = %+v", i)
	}
	if img, _ := tr.Current(); img != nil {
		t.Error("disabled terrain served an image")
	}
	var nilT *Terrain
	if nilT.Info() != nil {
		t.Error("nil terrain has info")
	}
}
