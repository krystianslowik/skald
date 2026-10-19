package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSafeRestartRoutes(t *testing.T) {
	h := newHarness(t)
	h.s.opt.RecoverTimeout = 5 * time.Second
	h.s.safe = h.s.newSafeRestart()
	srv := httptest.NewServer(h.s.Handler())
	defer srv.Close()

	code, v := jsonReq(t, srv, "GET", "/restart/safe", "")
	if data := v["data"].(map[string]any); code != 200 || data["run"] != nil || data["reason"] != "" {
		t.Fatalf("GET = %d %v", code, v)
	}
	if code, _ := jsonReq(t, srv, "POST", "/restart/safe", `nope`); code != 400 {
		t.Fatalf("bad body = %d", code)
	}
	if code, _ := jsonReq(t, srv, "POST", "/restart/safe", `{"warnMinutes":99}`); code != 400 {
		t.Fatalf("bad minutes = %d", code)
	}
	if code, _ := jsonReq(t, srv, "DELETE", "/restart/safe", ""); code != 404 {
		t.Fatalf("cancel with nothing running = %d", code)
	}

	// Someone plays: the run waits, and holds the game meanwhile.
	h.tr.HandleLine("Got character ZDOID from Ragnar : 123456789:1")
	if code, v := jsonReq(t, srv, "POST", "/restart/safe", `{"whenEmpty":true,"warnMinutes":5,"locale":"pl"}`); code != 202 || v["data"].(map[string]any)["actor"] != "jarl" {
		t.Fatalf("start = %d %v", code, v)
	}
	if code, _ := jsonReq(t, srv, "POST", "/restart/safe", `{}`); code != 409 {
		t.Fatalf("second run = %d", code)
	}
	if r := h.do(t, "POST", "/action/restart", token); r.StatusCode != 409 {
		t.Fatalf("plain restart during a run = %d", r.StatusCode)
	}
	if r := h.do(t, "POST", "/action/backup", token); r.StatusCode != 200 {
		t.Fatalf("backup during a wait = %d", r.StatusCode)
	}
	if code, _ := jsonReq(t, srv, "POST", "/restore", `{"source":"image","backup":"worlds-20261009-230500.zip","confirm":"Midgard"}`); code != 409 && code != 400 {
		t.Fatalf("restore during a run = %d", code)
	}
	var st map[string]any
	r := h.do(t, "GET", "/state", token)
	_ = json.NewDecoder(r.Body).Decode(&st)
	r.Body.Close()
	run, _ := st["safeRestart"].(map[string]any)
	if run == nil || run["state"] != "running" || run["step"] != "wait" {
		t.Fatalf("/state safeRestart = %v", st["safeRestart"])
	}
	if code, _ := jsonReq(t, srv, "DELETE", "/restart/safe", ""); code != 200 {
		t.Fatalf("cancel = %d", code)
	}
	h.s.safe.Wait()
	if v := h.s.safe.View(); v.State != "cancelled" || v.CancelledBy != "jarl" {
		t.Fatalf("after cancel %+v", v)
	}
	for _, c := range h.fake.Calls() {
		if c.Method == "supervisor.stopProcess" || c.Method == "supervisor.startProcess" {
			t.Fatalf("game touched by a cancelled run: %v", h.fake.Calls())
		}
	}

	// Nobody on: straight through, the world backed up and the run in the events.
	h.tr.HandleLine("Destroying abandoned non persistent zdo 123456789:1 owner 123456789")
	h.tr.HandleLine(`Player connection lost server "My Valheim" that has join code 000000, now 0 player(s)`)
	_, ch := h.hub.Subscribe(0)
	defer h.hub.Unsubscribe(ch)
	if code, v := jsonReq(t, srv, "POST", "/restart/safe", `{}`); code != 202 {
		t.Fatalf("start = %d %v", code, v)
	}
	var steps []string
	timeout := time.After(10 * time.Second)
	for done := false; !done; {
		select {
		case ev := <-ch:
			if ev.Type != "restart_run" {
				continue
			}
			step, result := ev.Data["step"].(string), ev.Data["result"].(string)
			steps = append(steps, step+":"+result)
			if step == "recover" && result == "running" {
				h.tr.HandleLine("Loading: Done. Total seconds sinze ZNet start 41.2")
			}
			done = step == "end"
		case <-timeout:
			t.Fatalf("timed out after %v", steps)
		}
	}
	want := "begin:running,wait:skipped,countdown:skipped,save:skipped,stop:running,stop:ok,backup:running,backup:ok,verify:running,verify:ok,start:running,start:ok,recover:running,recover:ok,end:done"
	if strings.Join(steps, ",") != want {
		t.Fatalf("steps =\n%v\nwant\n%v", strings.Join(steps, ","), want)
	}
	v2 := h.s.safe.View()
	if !strings.HasPrefix(v2.Archive, "pre-restart-") || v2.ArchiveBytes == 0 {
		t.Fatalf("archive %q %d", v2.Archive, v2.ArchiveBytes)
	}
	if h.s.Restarting() {
		t.Fatal("still marked restarting")
	}
	// The lock is free again.
	if r := h.do(t, "POST", "/action/backup", token); r.StatusCode != 200 {
		t.Fatalf("after the run = %d", r.StatusCode)
	}
}
