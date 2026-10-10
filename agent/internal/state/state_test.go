package state

import (
	"bufio"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
)

func types(evs []events.Event) map[string]int {
	out := map[string]int{}
	for _, e := range evs {
		out[e.Type]++
	}
	return out
}

func drain(h *events.Hub) []events.Event {
	evs, ch := h.Subscribe(0)
	h.Unsubscribe(ch)
	return evs
}

func TestStartupLogFinalState(t *testing.T) {
	f, err := os.Open("../../testdata/startup-1.0.17.log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	h := events.New(events.DefaultRingSize, events.DefaultLogSize)
	tr := New(h)
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		tr.HandleLine(sc.Text())
		n++
	}
	s := tr.Snapshot()
	if s.Version != "l-1.0.17" || s.NetworkVersion != 40 {
		t.Errorf("version = %q/%d", s.Version, s.NetworkVersion)
	}
	if s.JoinCode != "482915" || s.JoinCodeAt == nil {
		t.Errorf("join code = %q at %v", s.JoinCode, s.JoinCodeAt)
	}
	if s.PlayersReported != 0 || len(s.Players) != 0 {
		t.Errorf("players = %d %+v", s.PlayersReported, s.Players)
	}
	if s.Playfab != "ok" {
		t.Errorf("playfab = %q", s.Playfab)
	}
	if s.LastLogAt == nil {
		t.Error("lastLogAt not set")
	}

	got := types(drain(h))
	want := map[string]int{"log": n, "version": 1, "join_code": 1, "playfab": 2} // playfab: connecting, then ok (deduped)
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s events = %d, want %d (all: %v)", k, got[k], v, got)
		}
	}
}

func TestPlayersLifecycle(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	lines := []string{
		`<14>Oct  9 23:00:00 supervisord: valheim-server 10/09/2026 23:00:00: Got character ZDOID from Ragnar : -123:1`,
		`<14>Oct  9 23:00:01 supervisord: valheim-server 10/09/2026 23:00:01: Got character ZDOID from Sigrid : 456:1`,
		`<14>Oct  9 23:00:02 supervisord: valheim-server 10/09/2026 23:00:02: Session "S" with join code 111111 and IP 1.2.3.4:2456 is active with 2 player(s)`,
		`<14>Oct  9 23:05:00 supervisord: valheim-server 10/09/2026 23:05:00: Got character ZDOID from Ragnar : 0:0`,
		`<14>Oct  9 23:05:10 supervisord: valheim-server 10/09/2026 23:05:10: Got character ZDOID from Ragnar : -999:1`,
		`<14>Oct  9 23:06:00 supervisord: valheim-server 10/09/2026 23:06:00: World saved ( 87.5ms )`,
	}
	for _, l := range lines {
		tr.HandleLine(l)
	}
	s := tr.Snapshot()
	if len(s.Players) != 2 || s.Players[0].Name != "Ragnar" || s.Players[1].Name != "Sigrid" {
		t.Fatalf("players = %+v", s.Players)
	}
	if s.PlayersReported != 2 || s.LastSaveAt == nil || s.LastSaveMs != 87.5 {
		t.Fatalf("state = %+v", s)
	}

	tr.HandleLine(`Oct  9 23:10:00 supervisord: valheim-server 10/09/2026 23:10:00: Session "S" with join code 111111 and IP 1.2.3.4:2456 is active with 0 player(s)`)
	if s := tr.Snapshot(); len(s.Players) != 0 || s.PlayersReported != 0 {
		t.Fatalf("after drop to 0: %+v", s)
	}

	got := types(drain(h))
	want := map[string]int{"player_join": 2, "death": 1, "player_leave": 2, "player_count": 2, "world_saved": 1, "join_code": 1, "server_state": 1}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s events = %d, want %d (all: %v)", k, got[k], v, got)
		}
	}
}

func TestStatusLeavingRunningClearsPlayers(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	tr.HandleLine(`supervisord: valheim-server Got character ZDOID from Ragnar : 5:1`)
	tr.SetStatus("running") // no change, no event
	tr.SetStatus("stopping")
	if s := tr.Snapshot(); len(s.Players) != 0 || s.Status != "stopping" {
		t.Fatalf("state = %+v", s)
	}
	got := types(drain(h))
	if got["server_state"] != 2 || got["player_leave"] != 1 {
		t.Fatalf("events = %v", got)
	}
}

func TestReadStatusFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "valheim-server.status")
	if got := ReadStatusFile(p); got != "unknown" {
		t.Errorf("missing = %q", got)
	}
	os.WriteFile(p, []byte("running\n"), 0o644)
	if got := ReadStatusFile(p); got != "running" {
		t.Errorf("got %q", got)
	}
}

func TestRaidAndNetStats(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	if tr.Snapshot().NetStats != nil {
		t.Fatal("netStats before any line")
	}
	lines := []string{
		`supervisord: valheim-server 10/09/2026 23:00:00: Connections 1 ZDOS:500  sent:3 recv:40`,
		`supervisord: valheim-server 10/09/2026 23:00:10: Connections 1 ZDOS:500  sent:9 recv:80`, // traffic only: no event
		`supervisord: valheim-server 10/09/2026 23:00:20: Connections 1 ZDOS:512  sent:9 recv:80`,
		`supervisord: valheim-server 10/09/2026 23:00:30: Connections 2 ZDOS:512  sent:9 recv:80`,
		`supervisord: valheim-server 10/09/2026 23:01:00: Random event set:army_eikthyr`,
		`supervisord: valheim-server 10/09/2026 23:20:00: Random event set:army_eikthyr`,
	}
	for _, l := range lines {
		tr.HandleLine(l)
	}
	ns := tr.Snapshot().NetStats
	if ns == nil || *ns != (NetStats{Connections: 2, ZDOs: 512, Sent: 9, Recv: 80}) {
		t.Fatalf("netStats = %+v", ns)
	}
	evs := drain(h)
	got := types(evs)
	if got["net_stats"] != 3 || got["raid"] != 2 {
		t.Fatalf("events = %v", got)
	}
	for _, e := range evs {
		if e.Type == "raid" && e.Data["name"] != "army_eikthyr" {
			t.Errorf("raid data = %v", e.Data)
		}
	}
}

// TestSessionLog replays a redacted 1.0.17 crossplay session: Ragnar (Xbox)
// joins, drops, reconnects from the same console as Freya; Bjorn (Steam)
// joins and later leaves. No ghost of Ragnar may remain.
func TestSessionLog(t *testing.T) {
	f, err := os.Open("../../testdata/session-1.0.17.log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	h := events.New(events.DefaultRingSize, events.DefaultLogSize)
	tr := New(h)
	tr.SetStatus("running")
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		tr.HandleLine(sc.Text())
	}
	s := tr.Snapshot()
	if len(s.Players) != 1 || s.Players[0].Name != "Freya" || s.Players[0].Platform != "xbox" {
		t.Fatalf("players = %+v", s.Players)
	}
	if s.PlayersReported != 1 {
		t.Errorf("playersReported = %d", s.PlayersReported)
	}
	if s.NetStats == nil || *s.NetStats != (NetStats{Connections: 1, ZDOs: 374680, Sent: 0, Recv: 469}) {
		t.Errorf("netStats = %+v", s.NetStats)
	}
	if s.LastSaveAt == nil || s.LastSaveMs != 488 {
		t.Errorf("save = %v %v", s.LastSaveAt, s.LastSaveMs)
	}

	var seq []string
	for _, e := range drain(h) {
		switch e.Type {
		case "player_join":
			seq = append(seq, "+"+e.Data["name"].(string)+"/"+e.Data["platform"].(string))
		case "player_leave":
			seq = append(seq, "-"+e.Data["name"].(string))
		case "world_backup", "world_saved", "death":
			seq = append(seq, e.Type)
		case "log":
			line := e.Data["line"].(string)
			for _, leak := range []string{"Xbox_2533", "Steam_7656", "playfab/0A1B", "remote player 1B2C", "AAAA0000"} {
				if strings.Contains(line, leak) {
					t.Errorf("log event leaks %q: %s", leak, line)
				}
			}
		}
	}
	want := []string{"+Ragnar/xbox", "-Ragnar", "+Freya/xbox", "+Bjorn/steam", "world_backup", "world_saved", "-Bjorn"}
	if strings.Join(seq, " ") != strings.Join(want, " ") {
		t.Errorf("sequence\n got %v\nwant %v", seq, want)
	}
	for _, l := range h.Logs(-1) {
		if strings.Contains(l.Line, "Xbox_2533") {
			t.Errorf("/logs leaks: %s", l.Line)
		}
	}
}

func TestReconnectSameNameNoFalseLeave(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	for _, l := range []string{
		`supervisord: valheim-server Got character ZDOID from Ragnar : 100:1`,
		`supervisord: valheim-server Got character ZDOID from Ragnar : 200:1`,
		// The old peer's objects are cleaned up after the new one spawned.
		`supervisord: valheim-server Destroying abandoned non persistent zdo 100:1 owner 100`,
		`supervisord: valheim-server Destroying abandoned non persistent zdo 999:1 owner 999`,
	} {
		tr.HandleLine(l)
	}
	if s := tr.Snapshot(); len(s.Players) != 1 {
		t.Fatalf("players = %+v", s.Players)
	}
	tr.HandleLine(`supervisord: valheim-server Destroying abandoned non persistent zdo 200:1 owner 200`)
	tr.HandleLine(`supervisord: valheim-server Destroying abandoned non persistent zdo 200:2 owner 200`)
	got := types(drain(h))
	if got["player_join"] != 1 || got["player_leave"] != 1 {
		t.Fatalf("events = %v", got)
	}
}

func TestPlatformClaimFIFOAndExpiry(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	tr.now = func() time.Time { return now }
	tr.SetStatus("running")
	tr.HandleLine(`supervisord: valheim-server PlayFab socket with remote ID playfab/A received local Platform ID Xbox_1234567`)
	now = now.Add(5 * time.Minute) // expired: that client never spawned
	tr.HandleLine(`supervisord: valheim-server PlayFab socket with remote ID playfab/B received local Platform ID Steam_1234567`)
	tr.HandleLine(`supervisord: valheim-server PlayFab socket with remote ID playfab/C received local Platform ID Xbox_7654321`)
	tr.HandleLine(`supervisord: valheim-server Got character ZDOID from Freya : 1:1`)
	tr.HandleLine(`supervisord: valheim-server Got character ZDOID from Bjorn : 2:1`)
	tr.HandleLine(`supervisord: valheim-server Got character ZDOID from Astrid : 3:1`)
	got := map[string]string{}
	for _, p := range tr.Snapshot().Players {
		got[p.Name] = p.Platform
	}
	want := map[string]string{"Freya": "steam", "Bjorn": "xbox", "Astrid": "unknown"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("platforms = %v, want %v", got, want)
	}
}
