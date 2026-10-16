package server

import (
	"archive/zip"
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

	"github.com/krystianslowik/skald/agent/internal/access"
	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/events"
)

// Fictional ids from the world fixture (testdata/world-progress).
const (
	fixtureSteam = "Steam_76561190000000003"
	fixtureXbox  = "Xbox_2533274900000001"
)

func jsonReq(t *testing.T, srv *httptest.Server, method, path, body string) (int, map[string]any) {
	t.Helper()
	r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	r.Header.Set("X-Agent-Token", token)
	r.Header.Set("X-Skald-Actor", "jarl")
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var v map[string]any
	_ = json.NewDecoder(res.Body).Decode(&v)
	return res.StatusCode, v
}

// accessHarness has a world with a known-player list and the lists enabled.
func accessHarness(t *testing.T) (*harness, *httptest.Server) {
	t.Helper()
	h := newHarness(t)
	src := "../../testdata/world-progress"
	entries, _ := os.ReadDir(src)
	dst := filepath.Join(h.dir, "worlds_local", "Midgard")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(src, e.Name()))
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.s.opt.Access = access.New(h.dir)
	srv := httptest.NewServer(h.s.Handler())
	t.Cleanup(srv.Close)
	return h, srv
}

// adminEvents drains the hub's admin events published so far.
func adminEvents(hub *events.Hub) []events.Event {
	replay, ch := hub.Subscribe(0)
	hub.Unsubscribe(ch)
	var out []events.Event
	for _, e := range replay {
		if e.Type == "admin" {
			out = append(out, e)
		}
	}
	return out
}

func TestAccessListsFromFiles(t *testing.T) {
	h, srv := accessHarness(t)
	list := filepath.Join(h.dir, "adminlist.txt")
	if err := os.WriteFile(list, []byte("// List admin players ID  ONE per line\nV_76561190000000003\nsomething-odd\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, v := jsonReq(t, srv, "GET", "/access", "")
	if code != 200 {
		t.Fatalf("GET /access = %d %v", code, v)
	}
	data := v["data"].(map[string]any)
	admins := data["admins"].(map[string]any)["entries"].([]any)
	first := admins[0].(map[string]any)
	if len(admins) != 2 || first["name"] != "bjornthebold" || first["platform"] != "steam" || first["known"] != true || admins[1].(map[string]any)["known"] != false {
		t.Fatalf("admins = %v", admins)
	}
	if data["writable"] != true || data["bans"].(map[string]any)["live"] != false {
		t.Fatalf("flags = %v", data)
	}

	if code, _ := jsonReq(t, srv, "POST", "/access/admins/add", `{"id":"Xbox 123"}`); code != 400 {
		t.Fatalf("bad id = %d", code)
	}
	if code, _ := jsonReq(t, srv, "POST", "/access/admins/add", `{"id":"`+fixtureSteam+`"}`); code != 409 {
		t.Fatalf("same account in another form = %d", code)
	}
	if code, _ := jsonReq(t, srv, "POST", "/access/admins/remove", `{"id":"V_1"}`); code != 404 {
		t.Fatalf("remove missing = %d", code)
	}
	if code, _ := jsonReq(t, srv, "POST", "/access/owners/add", `{"id":"V_1"}`); code != 404 {
		t.Fatalf("unknown list = %d", code)
	}

	// One tap: an online player whose id the world knows.
	h.tr.HandleLine("Got character ZDOID from ragnar#1111 : 123456789:1")
	code, v = jsonReq(t, srv, "GET", "/access", "")
	online := v["data"].(map[string]any)["online"].([]any)
	if code != 200 || len(online) != 1 || online[0].(map[string]any)["canAdd"] != true || online[0].(map[string]any)["admin"] != false {
		t.Fatalf("online = %v", online)
	}
	if code, v := jsonReq(t, srv, "POST", "/access/admins/add", `{"player":"ragnar#1111"}`); code != 200 || v["data"].(map[string]any)["applies"] != "restart" {
		t.Fatalf("add online = %d %v", code, v)
	}
	if code, _ := jsonReq(t, srv, "POST", "/access/admins/add", `{"player":"nobody"}`); code != 404 {
		t.Fatalf("add unknown player = %d", code)
	}
	if code, _ := jsonReq(t, srv, "POST", "/access/admins/remove", `{"id":"something-odd"}`); code != 200 {
		t.Fatalf("remove unknown format = %d", code)
	}
	got, _ := os.ReadFile(list)
	if string(got) != "// List admin players ID  ONE per line\nV_76561190000000003\n"+fixtureXbox+"\n" {
		t.Fatalf("adminlist.txt = %q", got)
	}

	evs := adminEvents(h.hub)
	if len(evs) != 2 {
		t.Fatalf("events = %v", evs)
	}
	if evs[0].Data["command"] != "admin-add" || evs[0].Data["player"] != "ragnar#1111" || evs[0].Data["actor"] != "jarl" {
		t.Fatalf("add event = %v", evs[0].Data)
	}
	if evs[1].Data["command"] != "admin-remove" || evs[1].Data["masked"] == nil {
		t.Fatalf("remove event = %v", evs[1].Data)
	}
	b, _ := json.Marshal(evs)
	if strings.Contains(string(b), "2533274900000001") || strings.Contains(string(b), "something-odd") {
		t.Fatalf("an event carries a raw id: %s", b)
	}
}

func TestAccessBansThroughTheBridge(t *testing.T) {
	h, _ := accessHarness(t)
	var seen []string
	bans := []string{fixtureSteam}
	plugin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seen = append(seen, r.Method+" "+r.URL.Path+" "+string(b))
		switch r.URL.Path {
		case "/v1/health":
			_, _ = io.WriteString(w, `{"ok":true,"data":{"plugin":"0.1.1","gameBuild":"l-1.0.17","worldLoaded":true}}`)
		case "/v1/players":
			_, _ = io.WriteString(w, `{"ok":true,"data":{"players":[]}}`)
		case "/v1/bans":
			out, _ := json.Marshal(map[string]any{"ok": true, "data": bans})
			_, _ = w.Write(out)
		default:
			_, _ = io.WriteString(w, `{"ok":true,"data":{}}`)
		}
	}))
	defer plugin.Close()
	h.s.opt.Bridge = bridge.New(bridge.Options{URL: plugin.URL, Token: "0123456789abcdef", Hub: h.hub, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	srv := httptest.NewServer(h.s.Handler())
	defer srv.Close()

	code, v := jsonReq(t, srv, "GET", "/access", "")
	b := v["data"].(map[string]any)["bans"].(map[string]any)
	if code != 200 || b["live"] != true || b["entries"].([]any)[0].(map[string]any)["name"] != "bjornthebold" {
		t.Fatalf("bans = %d %v", code, b)
	}
	if code, _ := jsonReq(t, srv, "POST", "/access/bans/add", `{"id":"V_76561190000000003"}`); code != 409 {
		t.Fatalf("ban the banned = %d", code)
	}
	if code, v := jsonReq(t, srv, "POST", "/access/bans/add", `{"id":"X_1234500000000009"}`); code != 200 || v["data"].(map[string]any)["applies"] != "now" {
		t.Fatalf("ban = %d %v", code, v)
	}
	if code, _ := jsonReq(t, srv, "POST", "/access/bans/remove", `{"id":"`+fixtureSteam+`"}`); code != 200 {
		t.Fatalf("unban = %d", code)
	}
	joined := strings.Join(seen, "\n")
	if !strings.Contains(joined, `POST /v1/ban {"player":"X_1234500000000009"}`) || !strings.Contains(joined, `POST /v1/unban {"player":"`+fixtureSteam+`"}`) {
		t.Fatalf("plugin saw:\n%s", joined)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "bannedlist.txt")); err == nil {
		t.Fatal("the file was written while the bridge was live")
	}
	// One event per bridge command, from the bridge client; none for a file.
	evs := adminEvents(h.hub)
	if len(evs) != 2 || evs[0].Data["command"] != "ban" || evs[1].Data["command"] != "unban" || evs[0].Data["result"] != "ok" || evs[0].Data["via"] != nil {
		t.Fatalf("events = %v", evs)
	}
	if b, _ := json.Marshal(evs); strings.Contains(string(b), "1234500000000009") || strings.Contains(string(b), fixtureSteam) {
		t.Fatalf("events leak an id: %s", b)
	}
}

func TestRestoreRoutes(t *testing.T) {
	h := newHarness(t)
	srv := httptest.NewServer(h.s.Handler())
	defer srv.Close()

	// A real backup of the world: the image's layout.
	name := "worlds-20261010-100000.zip"
	p := filepath.Join(h.dir, "backups", name)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, n := range []string{"worlds_local/Midgard/_main.1.db2", "worlds_local/Midgard/_main.1.fwl2", "worlds_local/Midgard/_main.1.ok"} {
		w, _ := zw.Create(n)
		_, _ = io.WriteString(w, "restored")
	}
	_ = zw.Close()
	_ = f.Close()

	code, v := jsonReq(t, srv, "GET", "/restore", "")
	data := v["data"].(map[string]any)
	if code != 200 || data["world"] != "Midgard" || data["reason"] != nil || len(data["backups"].([]any)) != 2 {
		t.Fatalf("GET /restore = %d %v", code, v)
	}
	if code, _ := jsonReq(t, srv, "POST", "/restore", `{"source":"image","backup":"`+name+`","confirm":"midgard"}`); code != 400 {
		t.Fatalf("wrong confirmation = %d", code)
	}
	if code, _ := jsonReq(t, srv, "POST", "/restore", `{"source":"image","backup":"worlds-20261009-230500.zip","confirm":"Midgard"}`); code != 400 {
		t.Fatalf("not a zip = %d", code)
	}
	_, ch := h.hub.Subscribe(0)
	defer h.hub.Unsubscribe(ch)
	if code, v := jsonReq(t, srv, "POST", "/restore", `{"source":"image","backup":"`+name+`","confirm":"Midgard"}`); code != 202 {
		t.Fatalf("restore = %d %v", code, v)
	}
	var steps []string
	timeout := time.After(5 * time.Second)
	for done := false; !done; {
		select {
		case ev := <-ch:
			if ev.Type != "admin" || ev.Data["command"] != "restore" {
				continue
			}
			steps = append(steps, ev.Data["step"].(string)+":"+ev.Data["result"].(string))
			done = ev.Data["step"] == "done" || ev.Data["result"] == "error"
		case <-timeout:
			t.Fatalf("timed out after %v", steps)
		}
	}
	if strings.Join(steps, ",") != "begin:ok,safety:ok,stop:ok,extract:ok,start:ok,done:ok" {
		t.Fatalf("steps = %v", steps)
	}
	if b, _ := os.ReadFile(filepath.Join(h.dir, "worlds_local", "Midgard", "_main.1.db2")); string(b) != "restored" {
		t.Fatalf("world = %q", b)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "worlds_local", "Midgard.db")); err == nil {
		t.Fatal("the old pre-1.0 files are still live")
	}
	// The lock is free again.
	deadline := time.Now().Add(2 * time.Second)
	for h.s.restoring.Load() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if r := h.do(t, "POST", "/action/backup", token); r.StatusCode != 200 {
		t.Fatalf("after restore = %d", r.StatusCode)
	}

	// Someone joins: refused before anything is touched.
	h.tr.HandleLine("Got character ZDOID from Ragnar : 123456789:1")
	if code, _ := jsonReq(t, srv, "POST", "/restore", `{"source":"image","backup":"`+name+`","confirm":"Midgard"}`); code != 409 {
		t.Fatalf("players online = %d", code)
	}
}
