package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/supervisor/supervisortest"
	"github.com/krystianslowik/skald/agent/internal/world"
	"github.com/krystianslowik/skald/agent/internal/worldmap"
)

// mapServer serves the worldmap fixture as world "Midgard".
func mapServer(t *testing.T, built bool) (*Server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	wdir := filepath.Join(dir, "worlds_local", "Midgard")
	if err := os.MkdirAll(wdir, 0o755); err != nil {
		t.Fatal(err)
	}
	src := "../../testdata/world-map"
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(src, e.Name()))
		if err := os.WriteFile(filepath.Join(wdir, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := worldmap.New(worldmap.Options{Dir: wdir, ShowNames: true, Logger: quiet})
	if built {
		if _, err := m.Refresh(); err != nil {
			t.Fatal(err)
		}
	}
	fake := supervisortest.New()
	hub := events.New(events.DefaultRingSize, events.DefaultLogSize)
	s := New(Options{
		Token: token, ConfigDir: dir, WorldName: "Midgard", Hub: hub, Tracker: state.New(hub),
		Supervisor: supervisor.New(fake.URL(), supervisortest.User, supervisortest.Pass),
		Map:        m, Logger: quiet,
	})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(func() {
		srv.Close()
		fake.Close()
	})
	return s, srv
}

func getMap(t *testing.T, url string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", url+"/map", nil)
	req.Header.Set("X-Agent-Token", token)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	// Plain transport: no transparent gzip, so Content-Encoding is visible.
	resp, err := (&http.Transport{DisableCompression: true}).RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestMapEndpoint(t *testing.T) {
	_, srv := mapServer(t, true)

	r := getMap(t, srv.URL, nil)
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		t.Fatalf("plain GET = %d %v", r.StatusCode, r.Header)
	}
	etag := r.Header.Get("ETag")
	var snap worldmap.Snapshot
	if err := json.NewDecoder(r.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.Portals) != 5 || len(snap.Storage) != 7 || snap.Meta.SeedName != "Yggdrasil1" || etag == "" {
		t.Errorf("snapshot portals %d storage %d seed %q etag %q", len(snap.Portals), len(snap.Storage), snap.Meta.SeedName, etag)
	}

	gz := getMap(t, srv.URL, map[string]string{"Accept-Encoding": "br, gzip;q=0.8"})
	if gz.Header.Get("Content-Encoding") != "gzip" || gz.Header.Get("ETag") != etag || gz.Header.Get("Vary") != "Accept-Encoding" {
		t.Fatalf("gzip GET headers = %v", gz.Header)
	}
	zr, err := gzip.NewReader(gz.Body)
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if !bytes.Contains(plain, []byte(`"seedName":"Yggdrasil1"`)) {
		t.Error("gzip body is not the snapshot")
	}

	if r := getMap(t, srv.URL, map[string]string{"Accept-Encoding": "gzip;q=0"}); r.Header.Get("Content-Encoding") != "" {
		t.Error("gzip;q=0 still got gzip")
	}
	if r := getMap(t, srv.URL, map[string]string{"If-None-Match": `"other", ` + etag}); r.StatusCode != 304 {
		t.Errorf("If-None-Match = %d, want 304", r.StatusCode)
	}

	req, _ := http.NewRequest("GET", srv.URL+"/map", nil)
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 401 {
		t.Errorf("no token: %v %v", resp.StatusCode, err)
	}
}

func TestMapEndpointNotReady(t *testing.T) {
	_, srv := mapServer(t, false)
	if r := getMap(t, srv.URL, nil); r.StatusCode != 503 || r.Header.Get("Retry-After") == "" {
		t.Errorf("before the first build = %d", r.StatusCode)
	}
	h := newHarness(t) // no Map at all
	if r := h.do(t, "GET", "/map", token); r.StatusCode != 404 {
		t.Errorf("map off = %d", r.StatusCode)
	}
}

func TestMapMetric(t *testing.T) {
	s, _ := mapServer(t, true)
	body, _ := scrape(t, s)
	if !strings.Contains(body, "\nvalheim_map_build_seconds ") || !strings.Contains(body, "\nvalheim_map_generation 3\n") {
		t.Errorf("map metrics missing:\n%s", body)
	}
}

func TestStateClock(t *testing.T) {
	_, srv := mapServer(t, true)
	get := func() map[string]any {
		req, _ := http.NewRequest("GET", srv.URL+"/state", nil)
		req.Header.Set("X-Agent-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var got map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		return got["world"].(map[string]any)
	}
	clock, ok := get()["clock"].(map[string]any)
	if !ok {
		t.Fatalf("world.clock missing")
	}
	// Fixture netTime 72900 = day 40 + 900 s: half way through the day, nobody on.
	if clock["day"] != float64(40) || clock["dayFraction"] != 0.5 || clock["advancing"] != false || clock["daylight"] != true || clock["rate"] != nil {
		t.Errorf("clock = %v", clock)
	}
}

func TestClockExtrapolatesWithPlayers(t *testing.T) {
	var s Server
	saved := time.Date(2026, 10, 10, 20, 0, 0, 0, time.UTC)
	meta := &world.Meta{NetTime: 1800*3 + 1700, SavedAt: saved}
	now := saved.Add(10 * time.Minute)

	asleep := s.clock(meta, nil, now)
	if asleep.Advancing || asleep.NetTime != meta.NetTime || asleep.Day != 3 || asleep.Daylight {
		t.Errorf("empty server clock = %+v", asleep)
	}
	// One player since before the save: 600 s past the save, into day 4.
	c := s.clock(meta, []state.Player{{Name: "a", Since: saved.Add(-time.Hour)}}, now)
	if !c.Advancing || c.NetTime != meta.NetTime+600 || c.Day != 4 {
		t.Errorf("clock with a player = %+v", c)
	}
	// Joined 2 minutes ago, after the save: only those 2 minutes count.
	c = s.clock(meta, []state.Player{{Name: "a", Since: now.Add(-2 * time.Minute)}}, now)
	if c.NetTime != meta.NetTime+120 {
		t.Errorf("late joiner clock = %+v", c)
	}
	// A second save 30 min later that gained 1800 s: rate 1.
	s.clock(&world.Meta{NetTime: meta.NetTime + 1800, SavedAt: saved.Add(30 * time.Minute)}, nil, now)
	if r := s.clocks.rate(); r == nil || *r != 1 {
		t.Errorf("rate = %v", r)
	}
	if s.clock(nil, nil, now) != nil {
		t.Error("clock without meta")
	}
}
