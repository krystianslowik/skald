package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/icons"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/supervisor/supervisortest"
)

func iconsServer(t *testing.T, dir string) *httptest.Server {
	t.Helper()
	fake := supervisortest.New()
	hub := events.New(events.DefaultRingSize, events.DefaultLogSize)
	s := New(Options{
		Token: token, ConfigDir: t.TempDir(), Hub: hub, Tracker: state.New(hub),
		Supervisor: supervisor.New(fake.URL(), supervisortest.User, supervisortest.Pass),
		Icons:      icons.New(dir), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		srv.Close()
		fake.Close()
	})
	return srv
}

func get(t *testing.T, url string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("X-Agent-Token", token)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func writeIcons(t *testing.T, dir, build, sheet string) {
	t.Helper()
	if sheet == "" {
		sheet = "sheet." + build + ".webp"
	}
	mustWriteBytes(t, filepath.Join(dir, "sheet."+build+".webp"), []byte("RIFF-fake-webp-"+build))
	doc, _ := json.Marshal(map[string]any{
		"version": 1, "build": build, "size": 64, "columns": 32, "width": 2048, "height": 64, "sheet": sheet, "count": 2,
		"items": map[string][2]int{"Wood": {0, 0}, "Stone": {64, 0}},
	})
	mustWriteBytes(t, filepath.Join(dir, "map.json"), doc)
}

func mustWriteBytes(t *testing.T, p string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func stateIcons(t *testing.T, url string) any {
	t.Helper()
	var st map[string]any
	if err := json.NewDecoder(get(t, url+"/state", nil).Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	v, ok := st["icons"]
	if !ok {
		t.Fatal("state has no icons key")
	}
	return v
}

func TestIconsOff(t *testing.T) {
	srv := iconsServer(t, "")
	for _, p := range []string{"/icons/map.json", "/icons/sheet.webp"} {
		if r := get(t, srv.URL+p, nil); r.StatusCode != 404 {
			t.Errorf("%s = %d, want 404", p, r.StatusCode)
		}
	}
	if v := stateIcons(t, srv.URL); v != nil {
		t.Errorf("state.icons = %v, want null", v)
	}
}

func TestIconsServeWithETag(t *testing.T) {
	dir := t.TempDir()
	srv := iconsServer(t, dir)
	// Not extracted yet: off in the routes, present but unavailable in /state.
	if r := get(t, srv.URL+"/icons/map.json", nil); r.StatusCode != 404 {
		t.Errorf("before extraction = %d", r.StatusCode)
	}
	if v := stateIcons(t, srv.URL).(map[string]any); v["available"] != false {
		t.Errorf("state.icons before = %v", v)
	}

	writeIcons(t, dir, "abc123", "")
	r := get(t, srv.URL+"/icons/map.json", nil)
	if r.StatusCode != 200 || r.Header.Get("ETag") != `"abc123"` || r.Header.Get("Cache-Control") != "no-cache" || r.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("map.json = %d %v", r.StatusCode, r.Header)
	}
	r = get(t, srv.URL+"/icons/sheet.webp?v=abc123", nil)
	body, _ := io.ReadAll(r.Body)
	if r.StatusCode != 200 || string(body) != "RIFF-fake-webp-abc123" || r.Header.Get("Content-Type") != "image/webp" ||
		r.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" || r.Header.Get("ETag") != `"abc123"` {
		t.Fatalf("sheet = %d %q %v", r.StatusCode, body, r.Header)
	}
	for _, p := range []string{"/icons/map.json", "/icons/sheet.webp"} {
		if r := get(t, srv.URL+p, map[string]string{"If-None-Match": `"abc123"`}); r.StatusCode != 304 {
			t.Errorf("%s revalidation = %d, want 304", p, r.StatusCode)
		}
	}
	if v := stateIcons(t, srv.URL).(map[string]any); v["available"] != true || v["build"] != "abc123" || v["count"] != float64(2) {
		t.Errorf("state.icons = %v", v)
	}

	// A new game build: new ETag, the old one no longer matches. (The stat
	// cache keys on mtime and size; force a different mtime.)
	writeIcons(t, dir, "def456", "")
	later := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(filepath.Join(dir, "map.json"), later, later)
	r = get(t, srv.URL+"/icons/sheet.webp", map[string]string{"If-None-Match": `"abc123"`})
	body, _ = io.ReadAll(r.Body)
	if r.StatusCode != 200 || r.Header.Get("ETag") != `"def456"` || string(body) != "RIFF-fake-webp-def456" {
		t.Errorf("after rebuild = %d %v %q", r.StatusCode, r.Header.Get("ETag"), body)
	}
}

func TestIconsRefuseOtherFiles(t *testing.T) {
	dir := t.TempDir()
	mustWriteBytes(t, filepath.Join(dir, "secret.webp"), []byte("nope"))
	writeIcons(t, dir, "abc123", "../secret.webp")
	srv := iconsServer(t, dir)
	for _, p := range []string{"/icons/map.json", "/icons/sheet.webp"} {
		if r := get(t, srv.URL+p, nil); r.StatusCode != 404 {
			t.Errorf("%s with a bad sheet name = %d, want 404", p, r.StatusCode)
		}
	}
}

func TestIconsNeedToken(t *testing.T) {
	dir := t.TempDir()
	writeIcons(t, dir, "abc123", "")
	srv := iconsServer(t, dir)
	resp, err := http.Get(srv.URL + "/icons/sheet.webp")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("without token = %d", resp.StatusCode)
	}
}
