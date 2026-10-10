package server

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/supervisor/supervisortest"
	"github.com/krystianslowik/skald/agent/internal/terrain"
	"github.com/krystianslowik/skald/agent/internal/world"
)

func terrainServer(t *testing.T, dir string, meta *world.Meta) (*terrain.Terrain, *httptest.Server) {
	t.Helper()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	tr := terrain.New(terrain.Options{Dir: dir, Meta: func() *world.Meta { return meta }, Logger: quiet})
	fake := supervisortest.New()
	hub := events.New(events.DefaultRingSize, events.DefaultLogSize)
	s := New(Options{
		Token: token, ConfigDir: t.TempDir(), Hub: hub, Tracker: state.New(hub),
		Supervisor: supervisor.New(fake.URL(), supervisortest.User, supervisortest.Pass),
		Terrain:    tr, Logger: quiet,
	})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		srv.Close()
		fake.Close()
	})
	return tr, srv
}

// A 64 px synthetic run: land in the north, sea in the south.
func writeTerrain(t *testing.T, dir string, seedHash int32) {
	t.Helper()
	n := 64
	b := make([]byte, n*n)
	h := make([]byte, 2*n*n)
	for i := 0; i < n*n; i++ {
		m := 0.0
		if i < n*n/2 {
			b[i], m = 1, 50
		}
		binary.LittleEndian.PutUint16(h[2*i:], uint16((m+500)*50))
	}
	mustWriteBytes(t, filepath.Join(dir, "biomes.u8"), b)
	mustWriteBytes(t, filepath.Join(dir, "height.u16le"), h)
	doc, _ := json.Marshal(map[string]any{"format": 1, "seed": "SecretSeedName", "seedHash": seedHash, "worldGenVersion": 2, "gameBuild": "l-1.0.17", "resolution": n, "radius": 10500})
	mustWriteBytes(t, filepath.Join(dir, "manifest.json"), doc)
}

func stateTerrain(t *testing.T, url string) map[string]any {
	t.Helper()
	var st map[string]any
	if err := json.NewDecoder(get(t, url+"/state", nil).Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	v, _ := st["terrain"].(map[string]any)
	return v
}

func TestTerrainRoutes(t *testing.T) {
	dir := t.TempDir()
	meta := &world.Meta{SeedName: "SecretSeedName", Seed: 4242, WorldGenVersion: 2}
	tr, srv := terrainServer(t, dir, meta)

	if r := get(t, srv.URL+"/terrain.png", nil); r.StatusCode != 404 {
		t.Errorf("before a run = %d", r.StatusCode)
	}
	st := stateTerrain(t, srv.URL)
	if st["available"] != false || st["stale"] != true || st["reason"] != "missing" {
		t.Errorf("state.terrain before = %v", st)
	}
	if req := st["request"].(map[string]any); req["seedHash"] != float64(4242) || req["worldGenVersion"] != float64(2) {
		t.Errorf("request = %v", req)
	}

	writeTerrain(t, dir, 4242)
	if err := tr.Refresh(); err != nil {
		t.Fatal(err)
	}
	r := get(t, srv.URL+"/terrain.png", nil)
	body, _ := io.ReadAll(r.Body)
	etag := r.Header.Get("ETag")
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "image/png" || !strings.HasPrefix(string(body), "\x89PNG") || etag == "" ||
		r.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("terrain.png = %d %v", r.StatusCode, r.Header)
	}
	if r := get(t, srv.URL+"/terrain.png", map[string]string{"If-None-Match": etag}); r.StatusCode != 304 {
		t.Errorf("revalidation = %d", r.StatusCode)
	}
	r = get(t, srv.URL+"/terrain.json", nil)
	raw, _ := io.ReadAll(r.Body)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	if r.StatusCode != 200 || doc["resolution"] != float64(64) || doc["radius"] != float64(10500) || doc["stale"] != false || `"t-`+doc["build"].(string)+`"` != etag {
		t.Errorf("terrain.json = %d %s", r.StatusCode, raw)
	}
	// The image and its document name no seed: only the hash the save already shows.
	if strings.Contains(string(raw), "SecretSeedName") || strings.Contains(string(body), "SecretSeedName") {
		t.Error("terrain leaks the seed name")
	}
	if st := stateTerrain(t, srv.URL); st["available"] != true || st["build"] != doc["build"] {
		t.Errorf("state.terrain = %v", st)
	}

	// A run for another world is never served.
	meta.Seed = 1
	if r := get(t, srv.URL+"/terrain.png", nil); r.StatusCode != 404 {
		t.Errorf("other seed served = %d", r.StatusCode)
	}
	if st := stateTerrain(t, srv.URL); st["available"] != false || st["reason"] != "seed" {
		t.Errorf("state.terrain for another seed = %v", st)
	}
}

func TestTerrainStateNullWithoutWorldOrDir(t *testing.T) {
	_, srv := terrainServer(t, "", nil)
	var st map[string]any
	_ = json.NewDecoder(get(t, srv.URL+"/state", nil).Body).Decode(&st)
	if v, ok := st["terrain"]; !ok || v != nil {
		t.Errorf("state.terrain = %v, want null", v)
	}
	if r := get(t, srv.URL+"/terrain.json", nil); r.StatusCode != 404 {
		t.Errorf("terrain.json = %d", r.StatusCode)
	}
}
