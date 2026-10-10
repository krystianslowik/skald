package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/krystianslowik/skald/agent/internal/bridge"
)

// A minimal plugin: health, one player, and an echo for every command.
func fakeBridge(t *testing.T) (*bridge.Client, *[]string) {
	t.Helper()
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("X-Skald-Actor")+" "+string(b))
		switch r.URL.Path {
		case "/v1/health":
			_, _ = io.WriteString(w, `{"ok":true,"data":{"plugin":"0.1.1","gameBuild":"l-1.0.17","worldLoaded":true}}`)
		case "/v1/players":
			_, _ = io.WriteString(w, `{"ok":true,"data":{"players":[{"uid":7,"name":"Ragnar","userId":"Xbox_2533274800000001","position":{"x":1,"y":2,"z":3},"hasCharacter":true}]}}`)
		case "/v1/time":
			_, _ = io.WriteString(w, `{"ok":true,"data":{"day":3,"dayFraction":0.5}}`)
		default:
			_, _ = io.WriteString(w, `{"ok":true,"data":{"near":"Ragnar","uid":7}}`)
		}
	}))
	t.Cleanup(srv.Close)
	return bridge.New(bridge.Options{URL: srv.URL, Token: "0123456789abcdef", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}), &seen
}

func TestBridgeRoutesOffWithoutToken(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"/bridge/status", "/bridge/players"} {
		if res := h.do(t, http.MethodGet, p, token); res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: %d", p, res.StatusCode)
		}
	}
}

func TestBridgeRoutes(t *testing.T) {
	h := newHarness(t)
	br, seen := fakeBridge(t)
	h.s.opt.Bridge = br
	srv := httptest.NewServer(h.s.Handler())
	defer srv.Close()

	req := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		r, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		r.Header.Set("X-Agent-Token", token)
		r.Header.Set("X-Skald-Actor", "admin-ab12")
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var v map[string]any
		_ = json.NewDecoder(res.Body).Decode(&v)
		return res.StatusCode, v
	}

	if code, v := req("GET", "/bridge/status", ""); code != 200 || v["available"] != true || v["tested"] != true || v["gameBuild"] != "l-1.0.17" {
		t.Fatalf("status %d %v", code, v)
	}
	code, v := req("GET", "/bridge/players", "")
	b, _ := json.Marshal(v)
	if code != 200 || strings.Contains(string(b), "2533") || !strings.Contains(string(b), `"platform":"xbox"`) {
		t.Fatalf("players %d %s", code, b)
	}
	if code, v := req("GET", "/bridge/time", ""); code != 200 || v["data"].(map[string]any)["day"] != float64(3) {
		t.Fatalf("time %d %v", code, v)
	}
	if code, _ := req("GET", "/bridge/weather", ""); code != 404 {
		t.Fatalf("unknown read %d", code)
	}
	code, v = req("POST", "/bridge/heal", `{"player":"Ragnar"}`)
	if code != 200 || v["data"].(map[string]any)["uid"] != nil {
		t.Fatalf("heal %d %v", code, v)
	}
	if last := (*seen)[len(*seen)-1]; last != `POST /v1/player/heal admin-ab12 {"player":"7"}` {
		t.Fatalf("forwarded %q", last)
	}
	if code, _ := req("POST", "/bridge/save", ""); code != 200 || (*seen)[len(*seen)-1] != "POST /v1/save admin-ab12 {}" {
		t.Fatalf("save %d %q", code, (*seen)[len(*seen)-1])
	}
	if code, _ := req("POST", "/bridge/godmode", `{}`); code != 404 {
		t.Fatalf("not allow-listed %d", code)
	}
	if code, _ := req("POST", "/bridge/save", `[1]`); code != 400 {
		t.Fatalf("array body %d", code)
	}
	if code, _ := req("POST", "/bridge/save", `{"x":"`+strings.Repeat("a", maxBridgeBody)+`"}`); code != 413 {
		t.Fatalf("big body %d", code)
	}

	h.s.restarting.Store(true)
	if code, v := req("GET", "/bridge/status", ""); code != 200 || v["reason"] != "restarting" || v["available"] != false {
		t.Fatalf("status while restarting %d %v", code, v)
	}
	if code, _ := req("POST", "/bridge/save", "{}"); code != 409 {
		t.Fatalf("command while restarting %d", code)
	}
	if res := h.do(t, http.MethodGet, "/bridge/status", "wrong"); res.StatusCode != 401 {
		t.Fatalf("no agent token %d", res.StatusCode)
	}
}
