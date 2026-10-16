package bridge

import (
	"context"
	"encoding/json"
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
	if forced != 0 {
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
	if len(replay) != 1 || replay[0].Type != "admin" || replay[0].Data["command"] != "ack-build" || replay[0].Data["actor"] != "me" {
		t.Fatalf("events %+v", replay)
	}
}

func TestAuditToAdminEvents(t *testing.T) {
	hub := events.New(100, 10)
	c := newClient(t, &fakePlugin{build: "l-1.0.17"}, hub, "")
	_, _ = c.Players(context.Background())
	line := func(s string) string {
		return "Oct 10 18:01:02 supervisord: valheim-server [Info   :Skald Bridge] [SkaldBridge] audit " + s
	}
	c.NoteLine(line(`actor=admin-1 cmd=POST /v1/spawn args={"items":[{"item":"Wood","amount":20},{"item":"SwordIron","amount":1,"quality":3}],"player":"1234567890123456789"}`))
	c.NoteLine(line(`actor=admin-1 cmd=POST /v1/spawn result=ok {"ok":true,"data":{"items":[],"stacks":3,"near":"Ragnar","position":{"x":1,"y":2,"z":3}}}`))
	c.NoteLine(line(`actor=admin-1 cmd=POST /v1/ban args={"player":"Xbox_2533274800000001"}`))
	c.NoteLine(line(`actor=admin-1 cmd=POST /v1/ban result=error no connected player 'Xbox_2533274800000001'`))
	c.NoteLine(line(`actor=k cmd=POST /v1/broadcast args={"text":"Restart in 5 min","type":"narrator"}`))
	c.NoteLine(line(`actor=k cmd=POST /v1/broadcast result=ok {"ok":true,"data":{"sentTo":2,"type":"narrator"}}`))
	c.NoteLine(line(`actor=k cmd=POST /v1/creatures/kill result=timeout`))
	replay, ch := hub.Subscribe(0)
	hub.Unsubscribe(ch)
	if len(replay) != 4 {
		t.Fatalf("want 4 admin events, got %+v", replay)
	}
	b, _ := json.Marshal(replay)
	for _, leak := range []string{"2533274800000001", "1234567890123456789"} {
		if strings.Contains(string(b), leak) {
			t.Fatalf("leaked %s: %s", leak, b)
		}
	}
	spawn := replay[0].Data
	if spawn["command"] != "spawn" || spawn["actor"] != "admin-1" || spawn["result"] != "ok" || spawn["player"] != "Ragnar" || spawn["stacks"] != float64(3) {
		t.Fatalf("spawn %+v", spawn)
	}
	if items, _ := spawn["items"].([]map[string]any); len(items) != 2 || items[1]["item"] != "SwordIron" || items[1]["quality"] != float64(3) {
		t.Fatalf("spawn items %+v", spawn["items"])
	}
	if ban := replay[1].Data; ban["command"] != "ban" || ban["result"] != "error" || ban["player"] != nil {
		t.Fatalf("ban %+v", ban)
	}
	if bc := replay[2].Data; bc["text"] != "Restart in 5 min" || bc["type"] != "narrator" || bc["sentTo"] != float64(2) {
		t.Fatalf("broadcast %+v", bc)
	}
	if k := replay[3].Data; k["command"] != "creature-kill" || k["result"] != "timeout" {
		t.Fatalf("kill %+v", k)
	}
}

func TestFillAuditSaysWhatWentIn(t *testing.T) {
	if Commands["fill-kilns"].Path != "/v1/build/fill-kilns" || Commands["fill-smelters"].Path != "/v1/build/fill-smelters" || Reads["stations"] != "/v1/build/stations" {
		t.Fatalf("fill routes missing from the allow-lists")
	}
	hub := events.New(100, 10)
	c := newClient(t, &fakePlugin{build: "l-1.0.17"}, hub, "")
	_, _ = c.Players(context.Background())
	line := func(s string) string {
		return "Oct 10 18:01:02 supervisord: valheim-server [Info   :Skald Bridge] [SkaldBridge] audit " + s
	}
	c.NoteLine(line(`actor=k cmd=POST /v1/build/fill-smelters args={"what":"both","ore":"IronScrap","radius":50,"player":"1234567890123456789"}`))
	c.NoteLine(line(`actor=k cmd=POST /v1/build/fill-smelters result=ok {"ok":true,"data":{"smelters":3,"skipped":1,"full":0,"unloaded":0,"added":{"IronScrap":3},"fuel":"Coal","near":"Ragnar","radius":50}}`))
	c.NoteLine(line(`actor=k cmd=POST /v1/build/fill-kilns args={"radius":50,"at":{"x":10.4,"z":-3}}`))
	c.NoteLine(line(`actor=k cmd=POST /v1/build/fill-kilns result=ok {"ok":true,"data":{"kilns":2,"full":1,"unloaded":0,"added":{"Wood":2},"near":"position","radius":50}}`))
	replay, ch := hub.Subscribe(0)
	hub.Unsubscribe(ch)
	if len(replay) != 2 {
		t.Fatalf("want 2 admin events, got %+v", replay)
	}
	sm := replay[0].Data
	if sm["command"] != "fill-smelters" || sm["what"] != "both" || sm["ore"] != "IronScrap" || sm["smelters"] != float64(3) || sm["skipped"] != float64(1) || sm["fuel"] != "Coal" || sm["player"] != "Ragnar" {
		t.Fatalf("fill-smelters %+v", sm)
	}
	if added, _ := sm["added"].(map[string]any); added["IronScrap"] != float64(3) {
		t.Fatalf("fill-smelters added %+v", sm["added"])
	}
	k := replay[1].Data
	if k["command"] != "fill-kilns" || k["kilns"] != float64(2) || k["full"] != float64(1) || k["player"] != nil || k["fuel"] != nil {
		t.Fatalf("fill-kilns %+v", k)
	}
	if added, _ := k["added"].(map[string]any); added["Wood"] != float64(2) {
		t.Fatalf("fill-kilns added %+v", k["added"])
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
