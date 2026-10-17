package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
)

// fakePlugin answers like bridge/plugin/HttpServer.cs, with synthetic players.
type fakePlugin struct {
	mu       sync.Mutex
	build    string
	disabled bool
	calls    []call
	bans     []string
	status   map[string]int // path -> forced status
}

type call struct {
	Method, Path, Actor, Token, Body string
	Length                           int64
}

const testToken = "test-token-0123456789"

func (f *fakePlugin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.calls = append(f.calls, call{r.Method, r.URL.Path, r.Header.Get("X-Skald-Actor"), r.Header.Get("X-Skald-Token"), string(body), r.ContentLength})
	build, disabled, forced := f.build, f.disabled, f.status[r.URL.Path]
	f.mu.Unlock()
	reply := func(status int, v any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	if r.Header.Get("X-Skald-Token") != testToken {
		reply(401, map[string]any{"ok": false, "error": "unauthorised"})
		return
	}
	if disabled {
		reply(503, map[string]any{"ok": false, "error": "bridge disabled: game API binding failed (ZNet.Kick)"})
		return
	}
	if r.Method == http.MethodPost && r.ContentLength <= 0 {
		reply(411, map[string]any{"ok": false, "error": "length required"})
		return
	}
	switch forced {
	case 0:
	case http.StatusTooManyRequests:
		reply(forced, map[string]any{"ok": false, "error": "too many terrain requests"})
		return
	case http.StatusGatewayTimeout:
		reply(forced, map[string]any{"ok": false, "error": "the game did not answer within 5000 ms"})
		return
	default:
		reply(forced, map[string]any{"ok": false, "error": "no connected player '1234567890123456789'"})
		return
	}
	ok := func(data any) { reply(200, map[string]any{"ok": true, "data": data}) }
	switch r.URL.Path {
	case "/v1/health":
		ok(map[string]any{"plugin": "0.1.1", "gameBuild": build, "worldLoaded": true, "timeFrozen": false})
	case "/v1/players":
		// Raw JSON: the uid is a full 64-bit long, beyond float64 precision.
		w.WriteHeader(200)
		_, _ = io.WriteString(w, `{"ok":true,"data":{"time":1,"players":[
			{"uid":1234567890123456789,"name":"Ragnar","platformId":"Xbox_2533274800000001","userId":"Xbox_2533274800000001","playfabId":"ABCDEF0123456789","position":{"x":10.04,"y":31,"z":-20.06},"hasCharacter":true,"health":25,"maxHealth":50},
			{"uid":42,"name":"Freya","platformId":"Steam_76561190000000002","userId":null,"playfabId":"0011","position":{"x":-5,"y":30,"z":5},"hasCharacter":true,"health":null,"maxHealth":null}]}}`)
	case "/v1/bans":
		f.mu.Lock()
		b := append([]string{}, f.bans...)
		f.mu.Unlock()
		ok(b)
	case "/v1/kick":
		ok(map[string]any{"kicked": "Ragnar", "uid": 1234567890123456789})
	case "/v1/ban":
		ok(map[string]any{"banned": "Xbox_2533274800000001", "name": "Ragnar", "banList": []string{"Xbox_2533274800000001"}})
	case "/v1/broadcast":
		reply(501, map[string]any{"ok": false, "error": "not possible server-side"})
	case "/v1/spawn":
		ok(map[string]any{"items": []any{}, "stacks": 3, "near": "Ragnar", "position": map[string]any{"x": 1, "y": 2, "z": 3}})
	case "/v1/time":
		ok(map[string]any{"day": 12, "dayFraction": 0.5})
	case "/v1/build/fill-smelters":
		ok(map[string]any{"smelters": 3, "skipped": 1, "full": 0, "unloaded": 0, "added": map[string]any{"IronScrap": 3}, "fuel": "Coal", "near": "Ragnar", "radius": 50})
	case "/v1/containers/add":
		ok(map[string]any{"prefab": "piece_chest_wood", "item": "Iron", "amount": 20, "position": map[string]any{"x": 10.5, "y": 31.2, "z": -4}, "loaded": true, "room": 460,
			"slots": []any{map[string]any{"x": 0, "y": 0, "added": 10, "stack": 30}, map[string]any{"x": 3, "y": 0, "added": 10, "stack": 10}}})
	case "/v1/build/fill-kilns":
		ok(map[string]any{"kilns": 2, "full": 1, "unloaded": 0, "added": map[string]any{"Wood": 2}, "near": "position", "radius": 50})
	default:
		ok(map[string]any{"near": "Ragnar"})
	}
}

func (f *fakePlugin) last() call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func newClient(t *testing.T, f *fakePlugin, hub *events.Hub, ack string) *Client {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return New(Options{URL: srv.URL + "/", Token: testToken, AckPath: ack, Hub: hub, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

func TestOffWithoutToken(t *testing.T) {
	if New(Options{URL: "http://127.0.0.1:9010"}) != nil {
		t.Fatal("a client without a token")
	}
}

func TestStatus(t *testing.T) {
	f := &fakePlugin{build: "l-1.0.17"}
	c := newClient(t, f, nil, "")
	st := c.Status(context.Background())
	if !st.Available || !st.Tested || st.GameBuild != "l-1.0.17" || st.Plugin != "0.1.1" || len(st.Commands) != len(Commands) {
		t.Fatalf("got %+v", st)
	}
	f.build = "l-1.0.20"
	if st = c.Status(context.Background()); !st.Available || !st.Tested {
		t.Fatalf("l-1.0.20 is a tested build: %+v", st)
	}
	f.build = "l-1.0.18"
	if st = c.Status(context.Background()); !st.Available || st.Tested {
		t.Fatalf("untested build: %+v", st)
	}
	f.disabled = true
	if st = c.Status(context.Background()); st.Available || st.Reason != "disabled" || !strings.Contains(st.Message, "binding failed") {
		t.Fatalf("disabled: %+v", st)
	}
	off := New(Options{URL: "http://127.0.0.1:1", Token: testToken, Timeout: time.Second})
	if st = off.Status(context.Background()); st.Available || st.Reason != "unreachable" {
		t.Fatalf("unreachable: %+v", st)
	}
	bad := New(Options{URL: newClient(t, &fakePlugin{build: "x"}, nil, "").opt.URL, Token: "wrong-token-0123456789"})
	if st = bad.Status(context.Background()); st.Reason != "token" {
		t.Fatalf("bad token: %+v", st)
	}
}

func TestPlayersStripIDs(t *testing.T) {
	c := newClient(t, &fakePlugin{build: "l-1.0.17"}, nil, "")
	ps, err := c.Players(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(ps)
	for _, leak := range []string{"2533274800000001", "76561190000000002", "ABCDEF", "1234567890123456789", "uid", "playfab"} {
		if strings.Contains(string(b), leak) {
			t.Fatalf("leaked %q: %s", leak, b)
		}
	}
	if len(ps) != 2 || ps[1].Name != "Ragnar" || ps[1].Platform != "xbox" || ps[0].Platform != "steam" || ps[1].X != 10.04 || *ps[1].Health != 25 {
		t.Fatalf("got %s", b)
	}
}

func TestRunSwapsNamesAndScrubs(t *testing.T) {
	f := &fakePlugin{build: "l-1.0.17"}
	c := newClient(t, f, nil, "")
	out, err := c.Run(context.Background(), "kick", map[string]any{"player": "ragnar"}, "Ąnna ślą-1 <x>")
	if err != nil {
		t.Fatal(err)
	}
	got := f.last()
	if got.Path != "/v1/kick" || got.Body != `{"player":"1234567890123456789"}` || got.Actor != "nnal-1x" || got.Token != testToken {
		t.Fatalf("forwarded %+v", got)
	}
	if b, _ := json.Marshal(out); string(b) != `{"kicked":"Ragnar"}` {
		t.Fatalf("answer %s", b)
	}
	// Teleport to another player: both names become uids.
	if _, err := c.Run(context.Background(), "teleport", map[string]any{"player": "Freya", "toPlayer": "Ragnar"}, ""); err != nil {
		t.Fatal(err)
	}
	if got = f.last(); got.Body != `{"player":"42","toPlayer":"1234567890123456789"}` || got.Actor != "" {
		t.Fatalf("forwarded %+v", got)
	}
	// Commands without a body still send {} (Mono answers 411 otherwise).
	if _, err := c.Run(context.Background(), "save", nil, ""); err != nil {
		t.Fatal(err)
	}
	if got = f.last(); got.Body != "{}" || got.Length != 2 {
		t.Fatalf("save sent %+v", got)
	}
	b, _ := json.Marshal(mustRun(t, c, "ban", map[string]any{"player": "Ragnar"}))
	if strings.Contains(string(b), "2533") || !strings.Contains(string(b), "Ragnar") {
		t.Fatalf("ban answer %s", b)
	}
}

func mustRun(t *testing.T, c *Client, name string, body map[string]any) any {
	t.Helper()
	out, err := c.Run(context.Background(), name, body, "")
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRunErrors(t *testing.T) {
	f := &fakePlugin{build: "l-1.0.17", status: map[string]int{"/v1/heal": 404}}
	c := newClient(t, f, nil, "")
	ctx := context.Background()
	check := func(err error, status int, want string) {
		t.Helper()
		if err == nil || StatusOf(err) != status || !strings.Contains(err.Error(), want) {
			t.Fatalf("want %d %q, got %v", status, want, err)
		}
	}
	_, err := c.Run(ctx, "weather", nil, "")
	check(err, 404, "unknown command")
	_, err = c.Run(ctx, "kick", map[string]any{"player": "Nobody"}, "")
	check(err, 404, "no connected player 'Nobody'")
	_, err = c.Run(ctx, "kick", map[string]any{"player": "Xbox_2533274800000001"}, "")
	check(err, 404, "no connected player")
	_, err = c.Run(ctx, "broadcast", map[string]any{"text": "hi", "type": "chat"}, "")
	check(err, 501, "not possible")
	// A plugin error that echoes a uid shows the name instead.
	f.status = map[string]int{"/v1/player/heal": 404}
	_, err = c.Run(ctx, "heal", map[string]any{"player": "Ragnar"}, "")
	check(err, 404, "no connected player 'Ragnar'")
	_, err = c.Run(ctx, "unban", map[string]any{"id": "nope"}, "")
	check(err, 404, "not on the ban list")
	_, err = New(Options{URL: "http://127.0.0.1:1", Token: testToken, Timeout: time.Second}).Run(ctx, "save", nil, "")
	check(err, 502, "bridge unavailable")
}

func TestBansOpaque(t *testing.T) {
	f := &fakePlugin{build: "l-1.0.17", bans: []string{"Xbox_2533274800000001", "Steam_76561190000000009"}}
	c := newClient(t, f, nil, "")
	ctx := context.Background()
	_, _ = c.Players(ctx) // Ragnar is seen once, so his entry gets a name
	bans, err := c.Bans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(bans)
	if strings.Contains(string(b), "2533") || strings.Contains(string(b), "7656") || bans[0].Name != "Ragnar" || bans[0].Platform != "xbox" || bans[1].Name != "" || len(bans[0].ID) != 16 {
		t.Fatalf("bans %s", b)
	}
	mustRun(t, c, "unban", map[string]any{"id": bans[1].ID})
	if got := f.last(); got.Path != "/v1/unban" || got.Body != `{"player":"Steam_76561190000000009"}` {
		t.Fatalf("unban sent %+v", got)
	}
}

func TestUntestedBuildGate(t *testing.T) {
	f := &fakePlugin{build: "l-1.0.18"}
	ack := filepath.Join(t.TempDir(), "bridge.json")
	hub := events.New(100, 10)
	c := newClient(t, f, hub, ack)
	ctx := context.Background()
	if _, err := c.Run(ctx, "save", nil, ""); StatusOf(err) != 409 || !strings.Contains(err.Error(), "untested game build l-1.0.18") {
		t.Fatalf("got %v", err)
	}
	if err := c.Acknowledge(ctx, "l-1.0.17", "me"); StatusOf(err) != 409 {
		t.Fatalf("acknowledged a build that is not running: %v", err)
	}
	if err := c.Acknowledge(ctx, "l-1.0.18", "me"); err != nil {
		t.Fatal(err)
	}
	mustRun(t, c, "save", nil)
	if st := c.Status(ctx); st.Tested || !st.Acknowledged {
		t.Fatalf("status %+v", st)
	}
	// Kept across a restart of the agent.
	c2 := New(Options{URL: c.opt.URL, Token: testToken, AckPath: ack})
	mustRun(t, c2, "save", nil)
	replay, ch := hub.Subscribe(0)
	hub.Unsubscribe(ch)
	// The refused save never reached the plugin, so it is not in the trail.
	if len(replay) != 2 || replay[0].Type != "admin" || replay[0].Data["command"] != "ack-build" || replay[0].Data["actor"] != "me" || replay[1].Data["command"] != "save" {
		t.Fatalf("events %+v", replay)
	}
}

// adminEvents drains the hub's history.
func adminEvents(t *testing.T, hub *events.Hub) []map[string]any {
	t.Helper()
	replay, ch := hub.Subscribe(0)
	hub.Unsubscribe(ch)
	var out []map[string]any
	for _, ev := range replay {
		if ev.Type != "admin" {
			t.Fatalf("unexpected %s event %+v", ev.Type, ev.Data)
		}
		out = append(out, ev.Data)
	}
	return out
}

// Every command the agent sends becomes exactly one `admin` event, built from
// the body it sent and the plugin's reply. Nothing comes from the game log.
func TestCommandsPublishAdminEvents(t *testing.T) {
	hub := events.New(100, 10)
	f := &fakePlugin{build: "l-1.0.17", status: map[string]int{"/v1/player/heal": 404, "/v1/creatures/kill": 504}}
	c := newClient(t, f, hub, "")
	ctx := context.Background()
	spawn := map[string]any{"player": "Ragnar", "items": []any{
		map[string]any{"item": "Wood", "amount": 20},
		map[string]any{"item": "SwordIron", "amount": 1, "quality": 3},
	}}
	if _, err := c.Run(ctx, "spawn", spawn, "admin-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Run(ctx, "broadcast", map[string]any{"text": "Restart in 5 min", "type": "narrator"}, "k"); StatusOf(err) != 501 {
		t.Fatalf("broadcast: %v", err)
	}
	if _, err := c.Run(ctx, "heal", map[string]any{"player": "Ragnar"}, "k"); StatusOf(err) != 404 {
		t.Fatalf("heal: %v", err)
	}
	if _, err := c.Run(ctx, "creature-kill", map[string]any{"radius": 30}, ""); StatusOf(err) != 504 {
		t.Fatalf("creature-kill: %v", err)
	}
	if err := c.BanEntry(ctx, "Xbox_2533274800000001", "k"); err != nil {
		t.Fatal(err)
	}
	// Refused before the plugin is asked: nothing ran, nothing to audit.
	if _, err := c.Run(ctx, "kick", map[string]any{"player": "Nobody"}, "k"); StatusOf(err) != 404 {
		t.Fatalf("kick: %v", err)
	}
	if _, err := c.Run(ctx, "unban", map[string]any{"id": "nope"}, "k"); StatusOf(err) != 404 {
		t.Fatalf("unban: %v", err)
	}

	evs := adminEvents(t, hub)
	if len(evs) != 5 {
		t.Fatalf("want 5 admin events, got %+v", evs)
	}
	b, _ := json.Marshal(evs)
	for _, leak := range []string{"2533274800000001", "1234567890123456789", "uid", "banList"} {
		if strings.Contains(string(b), leak) {
			t.Fatalf("leaked %s: %s", leak, b)
		}
	}
	sp := evs[0]
	if sp["command"] != "spawn" || sp["actor"] != "admin-1" || sp["result"] != "ok" || sp["player"] != "Ragnar" || sp["stacks"] != float64(3) || sp["error"] != nil {
		t.Fatalf("spawn %+v", sp)
	}
	if items, _ := sp["items"].([]map[string]any); len(items) != 2 || items[1]["item"] != "SwordIron" || items[1]["quality"] != float64(3) {
		t.Fatalf("spawn items %+v", sp["items"])
	}
	if bc := evs[1]; bc["command"] != "broadcast" || bc["result"] != "error" || bc["text"] != "Restart in 5 min" || bc["type"] != "narrator" || bc["error"] != "not possible server-side" {
		t.Fatalf("broadcast %+v", bc)
	}
	// The plugin's error names the uid; the event names the player.
	if h := evs[2]; h["command"] != "heal" || h["result"] != "error" || h["player"] != "Ragnar" || h["error"] != "no connected player 'Ragnar'" {
		t.Fatalf("heal %+v", h)
	}
	if k := evs[3]; k["command"] != "creature-kill" || k["result"] != "timeout" || k["actor"] != "unknown" || k["radius"] != float64(30) || k["error"] != nil {
		t.Fatalf("creature-kill %+v", k)
	}
	if ban := evs[4]; ban["command"] != "ban" || ban["result"] != "ok" || ban["player"] != "Ragnar" || ban["actor"] != "k" {
		t.Fatalf("ban %+v", ban)
	}
}

// A plugin that does not answer in the agent's own time: the command may
// still run, so it is a timeout, not a failure.
func TestCommandAgentTimeout(t *testing.T) {
	hub := events.New(100, 10)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/health" {
			_, _ = io.WriteString(w, `{"ok":true,"data":{"gameBuild":"l-1.0.17","worldLoaded":true}}`)
			return
		}
		<-release
	}))
	defer srv.Close()
	defer close(release)
	c := New(Options{URL: srv.URL, Token: testToken, Hub: hub, Timeout: 200 * time.Millisecond})
	if _, err := c.Run(context.Background(), "save", nil, ""); StatusOf(err) != http.StatusGatewayTimeout {
		t.Fatalf("got %v", err)
	}
	evs := adminEvents(t, hub)
	if len(evs) != 1 || evs[0]["command"] != "save" || evs[0]["result"] != "timeout" || evs[0]["actor"] != "unknown" {
		t.Fatalf("events %+v", evs)
	}
}

// Reads change nothing and are never audited, also when the plugin turns
// one away (#63: a busy map produced dozens of "failed admin command" events).
func TestReadsPublishNothing(t *testing.T) {
	hub := events.New(100, 10)
	f := &fakePlugin{build: "l-1.0.17", status: map[string]int{"/v1/terrain/tile": 429, "/v1/locations": 404}}
	c := newClient(t, f, hub, "")
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if _, _, err := c.TerrainTile(ctx, 64, 0, 0, 8); StatusOf(err) != 429 {
			t.Fatalf("tile: %v", err)
		}
	}
	if _, err := c.Read(ctx, "time"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Read(ctx, "locations"); StatusOf(err) != 404 {
		t.Fatalf("locations: %v", err)
	}
	if _, err := c.Players(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Bans(ctx); err != nil {
		t.Fatal(err)
	}
	_ = c.Status(ctx)
	if evs := adminEvents(t, hub); len(evs) != 0 {
		t.Fatalf("reads published %+v", evs)
	}
}

// The same admin running the same command at once gets one event per call,
// each with its own arguments (#31: log lines were paired by actor+command).
func TestConcurrentCommandsKeepTheirArguments(t *testing.T) {
	hub := events.New(100, 10)
	c := newClient(t, &fakePlugin{build: "l-1.0.17"}, hub, "")
	const n = 12
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := c.Run(context.Background(), "time", map[string]any{"dayFraction": float64(i) / n}, "admin-1"); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	evs := adminEvents(t, hub)
	seen := map[float64]int{}
	for _, ev := range evs {
		if ev["command"] != "time" || ev["result"] != "ok" || ev["actor"] != "admin-1" {
			t.Fatalf("event %+v", ev)
		}
		f, _ := ev["dayFraction"].(float64)
		seen[f]++
	}
	if len(evs) != n || len(seen) != n {
		t.Fatalf("want %d distinct events, got %d events, %d distinct: %+v", n, len(evs), len(seen), evs)
	}
}

func TestFillAuditSaysWhatWentIn(t *testing.T) {
	if Commands["fill-kilns"].Path != "/v1/build/fill-kilns" || Commands["fill-smelters"].Path != "/v1/build/fill-smelters" || Reads["stations"] != "/v1/build/stations" {
		t.Fatalf("fill routes missing from the allow-lists")
	}
	hub := events.New(100, 10)
	c := newClient(t, &fakePlugin{build: "l-1.0.17"}, hub, "")
	ctx := context.Background()
	if _, err := c.Run(ctx, "fill-smelters", map[string]any{"what": "both", "ore": "IronScrap", "radius": 50, "player": "Ragnar"}, "k"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Run(ctx, "fill-kilns", map[string]any{"radius": 50, "at": map[string]any{"x": 10.4, "z": -3}}, "k"); err != nil {
		t.Fatal(err)
	}
	// Choosing the ore reads the stations first; a read is never audited.
	if _, err := c.Read(ctx, "stations"); err != nil {
		t.Fatal(err)
	}
	evs := adminEvents(t, hub)
	if len(evs) != 2 {
		t.Fatalf("want 2 admin events, got %+v", evs)
	}
	b, _ := json.Marshal(evs)
	if strings.Contains(string(b), "1234567890123456789") {
		t.Fatalf("leaked a uid: %s", b)
	}
	sm := evs[0]
	if sm["command"] != "fill-smelters" || sm["what"] != "both" || sm["ore"] != "IronScrap" || sm["smelters"] != float64(3) || sm["skipped"] != float64(1) || sm["fuel"] != "Coal" || sm["player"] != "Ragnar" {
		t.Fatalf("fill-smelters %+v", sm)
	}
	if added, _ := sm["added"].(map[string]any); added["IronScrap"] != float64(3) {
		t.Fatalf("fill-smelters added %+v", sm["added"])
	}
	k := evs[1]
	if k["command"] != "fill-kilns" || k["kilns"] != float64(2) || k["full"] != float64(1) || k["player"] != nil || k["fuel"] != nil {
		t.Fatalf("fill-kilns %+v", k)
	}
	if added, _ := k["added"].(map[string]any); added["Wood"] != float64(2) {
		t.Fatalf("fill-kilns added %+v", k["added"])
	}
}

func TestChestAdd(t *testing.T) {
	hub := events.New(100, 10)
	f := &fakePlugin{build: "l-1.0.17"}
	c := newClient(t, f, hub, "")
	ctx := context.Background()
	body := map[string]any{"prefab": "piece_chest_wood", "item": "Iron", "amount": 20, "at": map[string]any{"x": 10.5, "y": 31.2, "z": -4.0}}
	res, err := c.Run(ctx, "chest-add", body, "k")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.last(); got.Path != "/v1/containers/add" || !strings.Contains(got.Body, `"y":31.2`) {
		t.Fatalf("plugin got %+v", got)
	}
	if slots, _ := res.(map[string]any)["slots"].([]any); len(slots) != 2 {
		t.Fatalf("answer %+v", res)
	}
	evs := adminEvents(t, hub)
	if len(evs) != 1 {
		t.Fatalf("want 1 admin event, got %+v", evs)
	}
	ev := evs[0]
	at, _ := ev["at"].(map[string]any)
	if ev["command"] != "chest-add" || ev["result"] != "ok" || ev["actor"] != "k" || ev["item"] != "Iron" || ev["amount"] != float64(20) ||
		ev["prefab"] != "piece_chest_wood" || ev["loaded"] != true || at["x"] != float64(11) || at["z"] != float64(-4) {
		t.Fatalf("event %+v", ev)
	}

	// Malformed bodies stop at the agent: no plugin call, but an error event each.
	count := func() int {
		f.mu.Lock()
		defer f.mu.Unlock()
		return len(f.calls)
	}
	calls := count()
	for name, bad := range map[string]map[string]any{
		"no item":      {"prefab": "piece_chest_wood", "amount": 1, "at": map[string]any{"x": 1, "y": 2, "z": 3}},
		"no y":         {"prefab": "piece_chest_wood", "item": "Iron", "amount": 1, "at": map[string]any{"x": 1, "z": 3}},
		"zero":         {"prefab": "piece_chest_wood", "item": "Iron", "amount": 0, "at": map[string]any{"x": 1, "y": 2, "z": 3}},
		"fraction":     {"prefab": "piece_chest_wood", "item": "Iron", "amount": 1.5, "at": map[string]any{"x": 1, "y": 2, "z": 3}},
		"too many":     {"prefab": "piece_chest_wood", "item": "Iron", "amount": 10000, "at": map[string]any{"x": 1, "y": 2, "z": 3}},
		"outside":      {"prefab": "piece_chest_wood", "item": "Iron", "amount": 1, "at": map[string]any{"x": 1, "y": 2, "z": 20000}},
		"string at":    {"prefab": "piece_chest_wood", "item": "Iron", "amount": 1, "at": "here"},
		"extra player": {"prefab": "piece_chest_wood", "item": "Iron", "amount": 1, "at": map[string]any{"x": 1, "y": 2, "z": 3}, "player": "Ragnar"},
	} {
		if _, err := c.Run(ctx, "chest-add", bad, "k"); StatusOf(err) != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %v", name, err)
		}
	}
	if count() != calls {
		t.Fatalf("a malformed chest-add reached the plugin")
	}
	evs = adminEvents(t, hub)
	if len(evs) != 9 {
		t.Fatalf("want 1 ok and 8 refused events, got %d", len(evs))
	}
	for _, ev := range evs[1:] {
		if ev["command"] != "chest-add" || ev["result"] != "error" || ev["actor"] != "k" || ev["error"] == "" || strings.Contains(fmt.Sprint(ev["error"]), "bridge 400") {
			t.Fatalf("refusal event %+v", ev)
		}
	}
}

func TestPositions(t *testing.T) {
	hub := events.New(100, 10)
	c := newClient(t, &fakePlugin{build: "l-1.0.17"}, hub, "")
	_, ch := hub.Subscribe(0)
	defer hub.Unsubscribe(ch)
	var mu sync.Mutex
	want := true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.RunPositions(ctx, 20*time.Millisecond, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return want
	})
	ev := <-ch
	if ev.Type != "positions" || ev.Seq != 0 {
		t.Fatalf("got %+v", ev)
	}
	b, _ := json.Marshal(ev.Data["players"])
	if string(b) != `[{"name":"Freya","platform":"steam","x":-5,"z":5,"health":null,"maxHealth":null},{"name":"Ragnar","platform":"xbox","x":10,"z":-20.1,"health":25,"maxHealth":50}]` {
		t.Fatalf("players %s", b)
	}
	// Unchanged samples are skipped: the next event is the clearing one.
	time.Sleep(80 * time.Millisecond)
	mu.Lock()
	want = false
	mu.Unlock()
	ev = <-ch
	if p, _ := ev.Data["players"].([]Position); ev.Type != "positions" || len(p) != 0 {
		t.Fatalf("clearing event %+v", ev)
	}
	select {
	case ev := <-ch:
		t.Fatalf("unexpected %+v", ev)
	case <-time.After(80 * time.Millisecond):
	}
}
