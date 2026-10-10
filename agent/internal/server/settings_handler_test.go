package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/settings"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
	"github.com/krystianslowik/skald/agent/internal/supervisor/supervisortest"
)

const secret = "hunter-2x"

// syncBuf is a log sink the restart goroutine and the test can share.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type settingsHarness struct {
	*harness
	store *settings.Store
	dir   string
	logs  *syncBuf
}

// The fake supervisor reports valheim-server started at 2026-10-09T22:27:55Z.
// Store writes happen at real time, after it, so a save is pending.
func newSettingsHarness(t *testing.T) *settingsHarness {
	t.Helper()
	dir := t.TempDir()
	pw := filepath.Join(t.TempDir(), "server-pass")
	os.WriteFile(pw, []byte("ognisko\n"), 0o400)
	store, err := settings.Open(dir, settings.Seed{Name: "My Valheim", Public: true, Args: "-crossplay -modifier raids less", PasswordFile: pw}, nil)
	if err != nil {
		t.Fatal(err)
	}
	fake := supervisortest.New()
	hub := events.New(events.DefaultRingSize, events.DefaultLogSize)
	tr := state.New(hub)
	logs := &syncBuf{}
	s := New(Options{
		Token:      token,
		ConfigDir:  t.TempDir(),
		WorldName:  "Midgard",
		ServerName: "My Valheim",
		ServerArgs: "-crossplay -modifier raids less",
		Hub:        hub,
		Tracker:    tr,
		Supervisor: supervisor.New(fake.URL(), supervisortest.User, supervisortest.Pass),
		Settings:   store,
		Logger:     slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	})
	h := &harness{s: s, srv: httptest.NewServer(s.Handler()), fake: fake, hub: hub, tr: tr, dir: dir}
	t.Cleanup(func() {
		h.srv.Close()
		fake.Close()
	})
	return &settingsHarness{harness: h, store: store, dir: dir, logs: logs}
}

func (h *settingsHarness) send(t *testing.T, method, path string, body any) (*http.Response, map[string]any) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	req.Header.Set("X-Agent-Token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func validBody() map[string]any {
	return map[string]any{
		"name": "Ragnar's Hall", "public": false, "preset": "hard",
		"modifiers": map[string]string{"raids": "none"}, "keys": []string{"nomap"}, "saveInterval": 900,
		"password": secret,
	}
}

func TestSettingsDisabledIs404(t *testing.T) {
	h := newHarness(t)
	for _, c := range [][2]string{{"GET", "/settings"}, {"GET", "/settings/password"}, {"PUT", "/settings"}, {"POST", "/settings/apply"}, {"DELETE", "/settings/apply"}} {
		if r := h.do(t, c[0], c[1], token); r.StatusCode != 404 && r.StatusCode != 405 {
			t.Errorf("%s %s = %d", c[0], c[1], r.StatusCode)
		}
	}
	r := h.do(t, "GET", "/state", token)
	var got map[string]any
	json.NewDecoder(r.Body).Decode(&got)
	if v, ok := got["settings"]; !ok || v != nil {
		t.Errorf("state.settings = %#v, want null", v)
	}
	m := httptest.NewRecorder()
	h.s.MetricsHandler().ServeHTTP(m, httptest.NewRequest("GET", "/metrics", nil))
	if strings.Contains(m.Body.String(), "valheim_settings_pending") {
		t.Error("settings metric while the feature is off")
	}
}

func TestSettingsGetSeeded(t *testing.T) {
	h := newSettingsHarness(t)
	r, got := h.send(t, "GET", "/settings", nil)
	if r.StatusCode != 200 || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("status = %d", r.StatusCode)
	}
	cur := got["current"].(map[string]any)
	if cur["name"] != "My Valheim" || cur["public"] != true || cur["modifiers"].(map[string]any)["raids"] != "less" {
		t.Errorf("current = %v", cur)
	}
	if un := cur["unmanaged"].([]any); len(un) != 1 || un[0] != "-crossplay" {
		t.Errorf("unmanaged = %v", un)
	}
	if got["pending"] != false || got["password"].(map[string]any)["set"] != true {
		t.Errorf("view = %v", got)
	}
	if _, has := cur["password"]; has {
		t.Error("password in current")
	}
	r, pw := h.send(t, "GET", "/settings/password", nil)
	if r.StatusCode != 200 || pw["password"] != "ognisko" {
		t.Errorf("password = %d %v", r.StatusCode, pw)
	}
}

func TestSettingsPutValidates(t *testing.T) {
	h := newSettingsHarness(t)
	b := validBody()
	b["name"] = "x"
	b["modifiers"] = map[string]string{"raids": "none; rm -rf /"}
	r, got := h.send(t, "PUT", "/settings", b)
	errs, _ := got["errors"].(map[string]any)
	if r.StatusCode != 400 || errs["name"] != "length" || errs["modifier.raids"] != "value" {
		t.Errorf("got %d %v", r.StatusCode, got)
	}
	// Free-form args are not part of the input at all.
	b = validBody()
	b["args"] = "-anything"
	if r, _ := h.send(t, "PUT", "/settings", b); r.StatusCode != 400 {
		t.Errorf("unknown field = %d", r.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "server.env")); !os.IsNotExist(err) {
		t.Error("invalid input wrote server.env")
	}
}

func TestSettingsPutPublishesWithoutPassword(t *testing.T) {
	h := newSettingsHarness(t)
	r, got := h.send(t, "PUT", "/settings", validBody())
	if r.StatusCode != 200 || got["pending"] != true {
		t.Fatalf("put = %d %v", r.StatusCode, got)
	}
	evs, ch := h.hub.Subscribe(0)
	h.hub.Unsubscribe(ch)
	if len(evs) != 1 || evs[0].Type != "settings_changed" {
		t.Fatalf("events = %+v", evs)
	}
	keys := evs[0].Data["changedKeys"].([]string)
	if strings.Join(keys, ",") != "name,password,public,preset,modifier.raids,key.nomap,saveInterval" {
		t.Errorf("changedKeys = %v", keys)
	}

	// /state carries the summary, and still the running (effective) name.
	r2 := h.do(t, "GET", "/state", token)
	stateBody, _ := io.ReadAll(r2.Body)
	var st map[string]any
	json.Unmarshal(stateBody, &st)
	sum := st["settings"].(map[string]any)
	if sum["enabled"] != true || sum["pending"] != true || sum["passwordSet"] != true || sum["armed"] != false {
		t.Errorf("state.settings = %v", sum)
	}
	if st["server"].(map[string]any)["name"] != "My Valheim" {
		t.Errorf("state.server.name = %v", st["server"].(map[string]any)["name"])
	}
	m := httptest.NewRecorder()
	h.s.MetricsHandler().ServeHTTP(m, httptest.NewRequest("GET", "/metrics", nil))
	if !strings.Contains(m.Body.String(), "valheim_settings_pending 1\n") {
		t.Error("metrics: no valheim_settings_pending 1")
	}

	// The password shows up nowhere but the files and its own endpoint.
	_, view := h.send(t, "GET", "/settings", nil)
	viewJSON, _ := json.Marshal(view)
	all, _ := json.Marshal(evs)
	for what, s := range map[string]string{"events": string(all), "logs": h.logs.String(), "state": string(stateBody), "view": string(viewJSON), "metrics": m.Body.String()} {
		if strings.Contains(s, secret) {
			t.Errorf("password leaked into %s", what)
		}
	}
	env, _ := os.ReadFile(filepath.Join(h.dir, "server.env"))
	if !strings.Contains(string(env), "SERVER_PASS="+secret+"\n") {
		t.Errorf("server.env = %q", env)
	}
}

func TestSettingsApplyNowRestarts(t *testing.T) {
	h := newSettingsHarness(t)
	h.send(t, "PUT", "/settings", validBody())
	_, ch := h.hub.Subscribe(1 << 30)
	defer h.hub.Unsubscribe(ch)

	r, got := h.send(t, "POST", "/settings/apply", map[string]string{"mode": "now"})
	if r.StatusCode != 200 || got["ok"] != true {
		t.Fatalf("apply = %d %v", r.StatusCode, got)
	}
	var seen []string
	timeout := time.After(2 * time.Second)
	for len(seen) < 4 {
		select {
		case ev := <-ch:
			switch ev.Type {
			case "settings_apply":
				seen = append(seen, "apply:"+ev.Data["state"].(string))
			case "action":
				seen = append(seen, "action:"+ev.Data["message"].(string))
			}
		case <-timeout:
			t.Fatalf("timed out: %v", seen)
		}
	}
	if strings.Join(seen, ",") != "apply:applying,action:restart started,action:restart complete,apply:applied" {
		t.Errorf("events = %v", seen)
	}
	var methods []string
	for _, c := range h.fake.Calls() {
		if c.Method != "supervisor.getAllProcessInfo" {
			methods = append(methods, c.Method)
		}
	}
	if strings.Join(methods, ",") != "supervisor.stopProcess,supervisor.startProcess" {
		t.Errorf("calls = %v", methods)
	}
	if strings.Contains(h.logs.String(), secret) {
		t.Error("password in logs")
	}
}

func TestSettingsApplyNowBusy(t *testing.T) {
	h := newSettingsHarness(t)
	h.fake.Block = make(chan struct{})
	defer close(h.fake.Block)
	h.do(t, "POST", "/action/restart", token)
	if r, _ := h.send(t, "POST", "/settings/apply", map[string]string{"mode": "now"}); r.StatusCode != 409 {
		t.Errorf("apply during restart = %d", r.StatusCode)
	}
	if r, _ := h.send(t, "POST", "/settings/apply", map[string]string{"mode": "later"}); r.StatusCode != 400 {
		t.Errorf("bad mode = %d", r.StatusCode)
	}
}

func TestSettingsApplyWhenEmpty(t *testing.T) {
	h := newSettingsHarness(t)
	ctx := context.Background()
	// Nothing saved yet: nothing to apply.
	if r, _ := h.send(t, "POST", "/settings/apply", map[string]string{"mode": "when_empty"}); r.StatusCode != 409 {
		t.Errorf("arm without changes = %d", r.StatusCode)
	}
	h.send(t, "PUT", "/settings", validBody())
	r, got := h.send(t, "POST", "/settings/apply", map[string]string{"mode": "when_empty"})
	if r.StatusCode != 200 || got["apply"].(map[string]any)["armed"] != true {
		t.Fatalf("arm = %d %v", r.StatusCode, got)
	}

	h.tr.SetStatus("running")
	h.tr.HandleLine(`supervisord: valheim-server 10/10/2026 20:00:00: Session "x" with join code 111111 and IP 1.2.3.4:2456 is active with 2 player(s)`)
	t0 := time.Date(2026, 10, 10, 20, 0, 0, 0, time.UTC)
	tick := func(d time.Duration) { h.s.applyTick(ctx, t0.Add(d)) }
	calls := func() int {
		n := 0
		for _, c := range h.fake.Calls() {
			if c.Method == "supervisor.stopProcess" {
				n++
			}
		}
		return n
	}

	tick(0)
	tick(2 * time.Minute)
	if calls() != 0 {
		t.Fatal("restarted with players online")
	}
	// Everyone leaves; the clock starts.
	h.tr.HandleLine(`supervisord: valheim-server 10/10/2026 20:02:00: Session "x" with join code 111111 and IP 1.2.3.4:2456 is active with 0 player(s)`)
	tick(2*time.Minute + 5*time.Second)
	tick(2*time.Minute + 50*time.Second)
	// Someone comes back before 60 s: reset.
	h.tr.HandleLine(`supervisord: valheim-server 10/10/2026 20:02:55: Session "x" with join code 111111 and IP 1.2.3.4:2456 is active with 1 player(s)`)
	tick(2*time.Minute + 70*time.Second)
	h.tr.HandleLine(`supervisord: valheim-server 10/10/2026 20:03:20: Session "x" with join code 111111 and IP 1.2.3.4:2456 is active with 0 player(s)`)
	tick(3*time.Minute + 20*time.Second)
	tick(4*time.Minute + 10*time.Second)
	if calls() != 0 {
		t.Fatal("restarted before 60 s of an empty server")
	}

	_, ch := h.hub.Subscribe(1 << 30)
	defer h.hub.Unsubscribe(ch)
	tick(4*time.Minute + 25*time.Second)
	if h.store.Armed() {
		t.Error("still armed after firing")
	}
	deadline := time.After(2 * time.Second)
	var states []string
	for len(states) < 2 {
		select {
		case ev := <-ch:
			if ev.Type == "settings_apply" {
				states = append(states, ev.Data["state"].(string)+"/"+ev.Data["mode"].(string))
			}
		case <-deadline:
			t.Fatalf("timed out: %v", states)
		}
	}
	if strings.Join(states, ",") != "applying/when_empty,applied/when_empty" || calls() != 1 {
		t.Errorf("states = %v, stops = %d", states, calls())
	}
}

func TestSettingsApplyWhenEmptyWaitsForLockAndCancels(t *testing.T) {
	h := newSettingsHarness(t)
	ctx := context.Background()
	h.send(t, "PUT", "/settings", validBody())
	h.send(t, "POST", "/settings/apply", map[string]string{"mode": "when_empty"})
	h.tr.SetStatus("running")
	t0 := time.Date(2026, 10, 10, 20, 0, 0, 0, time.UTC)

	// Another action holds the lock when the minute is up: retry next tick.
	h.s.busy.Lock()
	h.s.applyTick(ctx, t0)
	h.s.applyTick(ctx, t0.Add(61*time.Second))
	if !h.store.Armed() {
		t.Fatal("gave up while busy")
	}
	h.s.busy.Unlock()

	_, ch := h.hub.Subscribe(1 << 30)
	defer h.hub.Unsubscribe(ch)
	r, got := h.send(t, "DELETE", "/settings/apply", nil)
	if r.StatusCode != 200 || got["apply"].(map[string]any)["armed"] != false {
		t.Errorf("cancel = %d %v", r.StatusCode, got)
	}
	select {
	case ev := <-ch:
		if ev.Type != "settings_apply" || ev.Data["state"] != "cancelled" {
			t.Errorf("event = %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no cancelled event")
	}
	h.s.applyTick(ctx, t0.Add(5*time.Minute))
	for _, c := range h.fake.Calls() {
		if c.Method == "supervisor.stopProcess" {
			t.Fatal("restarted after cancel")
		}
	}
}
