package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/compat"
)

// withCompat serves h's server with a compatibility checker over its tracker.
func withCompat(t *testing.T, h *harness, wait time.Duration) (*compat.Checker, *httptest.Server) {
	t.Helper()
	c := compat.New(compat.Options{
		State:   h.tr.Snapshot,
		Publish: func(typ string, data map[string]any) { h.hub.Publish(typ, data) },
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		WaitFor: wait,
		Poll:    time.Millisecond,
	})
	h.s.opt.Compat = c
	srv := httptest.NewServer(h.s.Handler())
	t.Cleanup(srv.Close)
	return c, srv
}

func call(t *testing.T, srv *httptest.Server, method, path string, header map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, nil)
	req.Header.Set("X-Agent-Token", token)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return resp, body
}

func TestCompatRoutes(t *testing.T) {
	h := newHarness(t)
	// Without a checker the routes do not exist and /state.compat is null.
	if r := h.do(t, "GET", "/compat", token); r.StatusCode != 404 {
		t.Errorf("GET /compat without a checker = %d", r.StatusCode)
	}
	_, st := call(t, h.srv, "GET", "/state", nil)
	if v, ok := st["compat"]; !ok || v != nil {
		t.Errorf("state.compat = %#v, want null", v)
	}

	h.tr.HandleLine(`<14>Oct  9 22:28:11 supervisord: valheim-server 10/09/2026 22:28:11: Valheim version: l-1.0.20 (network version 41)`)
	c, srv := withCompat(t, h, time.Minute)
	if r, _ := call(t, srv, "GET", "/compat", nil); r.StatusCode != 200 {
		t.Fatalf("GET /compat = %d", r.StatusCode)
	}

	// A check waits for the world: the second ask is refused.
	r, body := call(t, srv, "POST", "/compat/run", map[string]string{"X-Skald-Actor": "Ragnar"})
	if r.StatusCode != http.StatusAccepted || body["ok"] != true {
		t.Fatalf("run = %d %v", r.StatusCode, body)
	}
	if r, body := call(t, srv, "POST", "/compat/run", nil); r.StatusCode != http.StatusConflict || body["ok"] != false {
		t.Errorf("second run = %d %v", r.StatusCode, body)
	}
	_, view := call(t, srv, "GET", "/compat", nil)
	if view["running"] != true {
		t.Errorf("view while running = %v", view)
	}
	h.tr.HandleLine(`<14>Oct  9 22:28:36 supervisord: valheim-server 10/09/2026 22:28:36: Loading: Done. Total seconds sinze ZNet start: 21.4`)
	deadline := time.Now().Add(5 * time.Second)
	for c.View().Running && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	_, st = call(t, srv, "GET", "/state", nil)
	cv, _ := st["compat"].(map[string]any)
	res, _ := cv["result"].(map[string]any)
	if cv["running"] != false || res["build"] != "l-1.0.20" || res["trigger"] != "manual" || res["status"] != "ok" {
		t.Fatalf("state.compat = %v", st["compat"])
	}

	// The ask is audited, and each step reaches the event stream.
	evs, ch := h.hub.Subscribe(0)
	h.hub.Unsubscribe(ch)
	var audit, running, done int
	for _, e := range evs {
		switch e.Type {
		case "admin":
			if e.Data["command"] == "compat-check" && e.Data["actor"] == "Ragnar" && e.Data["result"] == "ok" {
				audit++
			}
		case "compat":
			if e.Data["running"] == true {
				running++
			} else {
				done++
			}
		}
	}
	if audit != 1 || running != 1 || done != 1 {
		t.Errorf("events: audit %d running %d done %d", audit, running, done)
	}
}

func TestEffectiveArgs(t *testing.T) {
	h := newHarness(t)
	h.s.opt.ServerArgs = "-public 1 -crossplay"
	if got := h.s.EffectiveArgs(context.Background()); got != "-public 1 -crossplay" {
		t.Errorf("args = %q", got)
	}
}

func TestCompatMetrics(t *testing.T) {
	h := newHarness(t)
	h.tr.HandleLine(`<14>Oct  9 22:28:11 supervisord: valheim-server 10/09/2026 22:28:11: Valheim version: l-1.0.20 (network version 41)`)
	h.tr.HandleLine(`<14>Oct  9 22:28:36 supervisord: valheim-server 10/09/2026 22:28:36: Loading: Done. Total seconds sinze ZNet start: 21.4`)
	c, _ := withCompat(t, h, time.Minute)
	rec := httptest.NewRecorder()
	h.s.MetricsHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if out := rec.Body.String(); !strings.Contains(out, "skald_compat_running 0\n") || strings.Contains(out, "skald_compat_status{") {
		t.Errorf("before a check:\n%s", out)
	}
	c.Tick(context.Background())
	rec = httptest.NewRecorder()
	h.s.MetricsHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	out := rec.Body.String()
	for _, want := range []string{
		`skald_compat_status{status="ok",build="l-1.0.20"} 1`,
		`skald_compat_check_status{check="version",status="ok",reason="first"} 1`,
		`skald_compat_check_status{check="save",status="skipped",reason="no_world"} 1`,
		`skald_compat_check_status{check="bridge",status="skipped",reason="not_configured"} 1`,
		`skald_compat_check_status{check="logs",status="ok",reason=""} 1`,
		"skald_compat_checked_timestamp_seconds ",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("metrics miss %s", want)
		}
	}
	if strings.Contains(out, "skald_compat_updated_from_info") {
		t.Error("a first check reports an update")
	}
}
