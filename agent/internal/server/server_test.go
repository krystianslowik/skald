package server

import (
	"bufio"
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
)

const token = "tok"

type harness struct {
	s    *Server
	srv  *httptest.Server
	fake *supervisortest.Fake
	hub  *events.Hub
	tr   *state.Tracker
	dir  string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "worlds_local", "Midgard.db"), 2048)
	mustWrite(t, filepath.Join(dir, "worlds_local", "Midgard.fwl"), 48)
	mustWrite(t, filepath.Join(dir, "backups", "worlds-20261009-230500.zip"), 512)

	fake := supervisortest.New()
	hub := events.New(events.DefaultRingSize, events.DefaultLogSize)
	tr := state.New(hub)
	s := New(Options{
		Token:      token,
		ConfigDir:  dir,
		WorldName:  "Midgard",
		ServerName: "My Valheim",
		Hub:        hub,
		Tracker:    tr,
		Supervisor: supervisor.New(fake.URL(), supervisortest.User, supervisortest.Pass),
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		PingEvery:  50 * time.Millisecond,
	})
	h := &harness{s: s, srv: httptest.NewServer(s.Handler()), fake: fake, hub: hub, tr: tr, dir: dir}
	t.Cleanup(func() {
		h.srv.Close()
		fake.Close()
	})
	return h
}

func mustWrite(t *testing.T, p string, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, make([]byte, n), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) do(t *testing.T, method, path string, tok string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, h.srv.URL+path, nil)
	if tok != "" {
		req.Header.Set("X-Agent-Token", tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestAuth(t *testing.T) {
	h := newHarness(t)
	if r := h.do(t, "GET", "/healthz", ""); r.StatusCode != 200 {
		t.Errorf("healthz = %d", r.StatusCode)
	}
	for _, tok := range []string{"", "wrong"} {
		if r := h.do(t, "GET", "/state", tok); r.StatusCode != 401 {
			t.Errorf("state with %q = %d", tok, r.StatusCode)
		}
	}
}

func TestState(t *testing.T) {
	h := newHarness(t)
	h.tr.SetStatus("running")
	h.tr.HandleLine(`<14>Oct  9 22:28:11 supervisord: valheim-server 10/09/2026 22:28:11: Valheim version: l-1.0.17 (network version 40)`)
	h.tr.HandleLine(`<14>Oct  9 22:28:39 supervisord: valheim-server 10/09/2026 22:28:39: Session "My Valheim" registered with join code 482915`)

	r := h.do(t, "GET", "/state", token)
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	srv := got["server"].(map[string]any)
	if srv["status"] != "running" || srv["version"] != "l-1.0.17" || srv["networkVersion"] != float64(40) ||
		srv["joinCode"] != "482915" || srv["playfab"] != "ok" || srv["name"] != "My Valheim" {
		t.Errorf("server = %v", srv)
	}
	procs := srv["processes"].(map[string]any)
	if procs["valheim-server"] != "RUNNING" || len(procs) != 3 {
		t.Errorf("processes = %v", procs)
	}
	if srv["serverStartedAt"] != "2026-10-09T22:27:55Z" {
		t.Errorf("serverStartedAt = %v", srv["serverStartedAt"])
	}
	world := got["world"].(map[string]any)
	if world["sizeBytes"] != float64(2096) || world["lastSaveAt"] == nil {
		t.Errorf("world = %v", world)
	}
	if m, ok := world["meta"]; !ok || m != nil {
		t.Errorf("world.meta = %#v, want null", m)
	}
	if ns, ok := srv["netStats"]; !ok || ns != nil {
		t.Errorf("server.netStats = %#v, want null", ns)
	}
	backups := got["backups"].([]any)
	if len(backups) != 1 || backups[0].(map[string]any)["name"] != "worlds-20261009-230500.zip" {
		t.Errorf("backups = %v", backups)
	}
	if players, ok := got["players"].([]any); !ok || len(players) != 0 {
		t.Errorf("players = %#v", got["players"])
	}
}

func TestStateWorldMetaAndNetStats(t *testing.T) {
	h := newHarness(t)
	dst := filepath.Join(h.dir, "worlds_local", "Midgard")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"_main.1.fwl2", "_main.1.db2", "_main.1.ok"} {
		b, err := os.ReadFile(filepath.Join("../../testdata/world-1.0", f))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, f), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.tr.HandleLine(`supervisord: valheim-server 10/09/2026 23:00:00: Connections 1 ZDOS:4242  sent:3 recv:40`)

	r := h.do(t, "GET", "/state", token)
	var got struct {
		Server struct {
			NetStats map[string]float64 `json:"netStats"`
		} `json:"server"`
		World struct {
			Meta map[string]any `json:"meta"`
		} `json:"world"`
	}
	if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	m := got.World.Meta
	if m["name"] != "Midgard" || m["seedName"] != "ZbzIWkK5KK" || m["seed"] != float64(353373721) ||
		m["worldGenVersion"] != float64(2) || m["netTime"] != float64(2040) || m["day"] != float64(1) || m["savedAt"] == nil {
		t.Errorf("world.meta = %v", m)
	}
	if ns := got.Server.NetStats; ns["connections"] != 1 || ns["zdos"] != 4242 {
		t.Errorf("netStats = %v", ns)
	}
}

func TestStateSupervisorDown(t *testing.T) {
	h := newHarness(t)
	h.fake.Close()
	r := h.do(t, "GET", "/state", token)
	if r.StatusCode != 200 {
		t.Fatalf("status = %d", r.StatusCode)
	}
	body, _ := io.ReadAll(r.Body)
	if !strings.Contains(string(body), `"processes":{}`) || !strings.Contains(string(body), `"status":"unknown"`) {
		t.Errorf("body = %s", body)
	}
}

func TestLogs(t *testing.T) {
	h := newHarness(t)
	for _, l := range []string{"a", "b", "c"} {
		h.tr.HandleLine("<14>Oct  9 22:28:39 supervisord: valheim-server " + l)
	}
	r := h.do(t, "GET", "/logs?limit=2", token)
	var got struct {
		Lines []struct{ TS, Line string }
	}
	json.NewDecoder(r.Body).Decode(&got)
	if len(got.Lines) != 2 || got.Lines[0].Line != "b" || got.Lines[1].Line != "c" || got.Lines[0].TS == "" {
		t.Errorf("lines = %+v", got.Lines)
	}
	if r := h.do(t, "GET", "/logs?limit=x", token); r.StatusCode != 400 {
		t.Errorf("bad limit = %d", r.StatusCode)
	}
}

// readEvents reads SSE frames until n data frames or a ping has been seen.
func readEvents(t *testing.T, body io.Reader, n int, wantPing bool) ([]events.Event, bool) {
	t.Helper()
	sc := bufio.NewScanner(body)
	var evs []events.Event
	pinged := false
	for sc.Scan() {
		line := sc.Text()
		if line == ": ping" {
			pinged = true
		}
		if d, ok := strings.CutPrefix(line, "data: "); ok {
			var ev events.Event
			if err := json.Unmarshal([]byte(d), &ev); err != nil {
				t.Fatal(err)
			}
			evs = append(evs, ev)
		}
		if len(evs) >= n && (!wantPing || pinged) {
			break
		}
	}
	return evs, pinged
}

func TestEventsReplayLiveAndPing(t *testing.T) {
	h := newHarness(t)
	h.tr.HandleLine("<14>Oct  9 22:28:39 supervisord: valheim-server one")
	h.tr.HandleLine("<14>Oct  9 22:28:39 supervisord: valheim-server two")

	r := h.do(t, "GET", "/events?since=1", token)
	defer r.Body.Close()
	if ct := r.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q", ct)
	}
	go func() {
		time.Sleep(20 * time.Millisecond)
		h.tr.HandleLine("<14>Oct  9 22:28:40 supervisord: valheim-backup three")
	}()
	evs, pinged := readEvents(t, r.Body, 2, true)
	if !pinged {
		t.Error("no ping")
	}
	if len(evs) != 2 || evs[0].Seq != 2 || evs[0].Data["line"] != "two" ||
		evs[1].Seq != 3 || evs[1].Data["program"] != "valheim-backup" || evs[1].Type != "log" {
		t.Errorf("events = %+v", evs)
	}
}

func TestActionBackupAndUpdate(t *testing.T) {
	h := newHarness(t)
	for name, program := range map[string]string{"backup": "valheim-backup", "update": "valheim-updater"} {
		r := h.do(t, "POST", "/action/"+name, token)
		var res actionResult
		json.NewDecoder(r.Body).Decode(&res)
		if r.StatusCode != 200 || !res.OK {
			t.Errorf("%s = %d %+v", name, r.StatusCode, res)
		}
		calls := h.fake.Calls()
		last := calls[len(calls)-1]
		if last.Method != "supervisor.signalProcess" || last.Params[0] != "<string>"+program+"</string>" || last.Params[1] != "<string>HUP</string>" {
			t.Errorf("%s call = %+v", name, last)
		}
	}
	evs, ch := h.hub.Subscribe(0)
	h.hub.Unsubscribe(ch)
	if len(evs) != 2 || evs[0].Type != "action" || evs[0].Data["ok"] != true {
		t.Errorf("action events = %+v", evs)
	}

	if r := h.do(t, "POST", "/action/nope", token); r.StatusCode != 404 {
		t.Errorf("unknown action = %d", r.StatusCode)
	}
}

func TestActionFault(t *testing.T) {
	h := newHarness(t)
	h.fake.Fault("supervisor.signalProcess", supervisor.FaultBadName, "BAD_NAME: valheim-backup")
	r := h.do(t, "POST", "/action/backup", token)
	var res actionResult
	json.NewDecoder(r.Body).Decode(&res)
	if r.StatusCode != 502 || res.OK || !strings.Contains(res.Message, "BAD_NAME") {
		t.Errorf("got %d %+v", r.StatusCode, res)
	}
}

func TestActionRestartBusyThenComplete(t *testing.T) {
	h := newHarness(t)
	h.fake.Block = make(chan struct{})
	// The server is already stopped: NOT_RUNNING must be tolerated.
	h.fake.Fault("supervisor.stopProcess", supervisor.FaultNotRunning, "NOT_RUNNING: valheim-server")

	_, ch := h.hub.Subscribe(0)
	defer h.hub.Unsubscribe(ch)

	r := h.do(t, "POST", "/action/restart", token)
	if r.StatusCode != 200 {
		t.Fatalf("restart = %d", r.StatusCode)
	}
	if r := h.do(t, "POST", "/action/backup", token); r.StatusCode != 409 {
		t.Errorf("concurrent action = %d, want 409", r.StatusCode)
	}
	close(h.fake.Block)

	var msgs []string
	timeout := time.After(2 * time.Second)
	for len(msgs) < 2 {
		select {
		case ev := <-ch:
			if ev.Type == "action" {
				msgs = append(msgs, ev.Data["message"].(string))
				if ev.Data["ok"] != true {
					t.Errorf("action not ok: %+v", ev)
				}
			}
		case <-timeout:
			t.Fatalf("timed out, got %v", msgs)
		}
	}
	if msgs[0] != "restart started" || msgs[1] != "restart complete" {
		t.Errorf("messages = %v", msgs)
	}

	var methods []string
	for _, c := range h.fake.Calls() {
		methods = append(methods, c.Method)
	}
	if strings.Join(methods, ",") != "supervisor.stopProcess,supervisor.startProcess" {
		t.Errorf("calls = %v", methods)
	}
	// Lock released: a new action goes through.
	if r := h.do(t, "POST", "/action/backup", token); r.StatusCode != 200 {
		t.Errorf("after restart = %d", r.StatusCode)
	}
}

// lastLeaveLines is the B-001 sequence: the only player leaves while the
// connection-lost line still says "now 1".
var lastLeaveLines = []string{
	`supervisord: valheim-server 10/16/2026 11:20:00: Player joined server "W" that has join code 123456, now 1 player(s)`,
	`supervisord: valheim-server 10/16/2026 11:20:30: Got character ZDOID from PlayerA : 123:5`,
	`supervisord: valheim-server 10/16/2026 11:39:00: Player connection lost server "W" that has join code 123456, now 1 player(s)`,
	`supervisord: valheim-server 10/16/2026 11:39:00: Destroying abandoned non persistent zdo 123:9 owner 123`,
}
