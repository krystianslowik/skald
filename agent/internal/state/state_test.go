package state

import (
	"bufio"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
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
// joins and later leaves; Freya dies and respawns. No ghost of Ragnar may
// remain and the respawn is not a second join.
var rawID = regexp.MustCompile(`Platform ID \w+_[^*]|\(\w+_[^*]`)

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
			if rawID.MatchString(line) {
				t.Errorf("log event keeps a platform id: %s", line)
			}
		}
	}
	want := []string{"+Ragnar/xbox", "-Ragnar", "+Freya/xbox", "+Bjorn/steam", "world_backup", "world_saved", "-Bjorn", "death"}
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

// lastLeaveLines is the prod sequence from B-001: the only player leaves and
// the connection-lost line still says "now 1".
var lastLeaveLines = []string{
	`supervisord: valheim-server 10/16/2026 11:20:00: Player joined server "W" that has join code 123456, now 1 player(s)`,
	`supervisord: valheim-server 10/16/2026 11:20:30: Got character ZDOID from PlayerA : 123:5`,
	`supervisord: valheim-server 10/16/2026 11:39:00: Player connection lost server "W" that has join code 123456, now 1 player(s)`,
	`supervisord: valheim-server 10/16/2026 11:39:00: Destroying abandoned non persistent zdo 123:9 owner 123`,
}

func TestLastLeaveLaggingCountEndsAtZero(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	for _, l := range lastLeaveLines {
		tr.HandleLine(l)
	}
	if s := tr.Snapshot(); s.PlayersReported != 0 || len(s.Players) != 0 {
		t.Fatalf("players=%d reported=%d", len(s.Players), s.PlayersReported)
	}
	var counts []any
	for _, e := range drain(h) {
		if e.Type == "player_count" {
			counts = append(counts, e.Data["count"])
		}
	}
	if !reflect.DeepEqual(counts, []any{1, 0}) {
		t.Errorf("player_count events = %v", counts)
	}
}

func TestLaggingCountAfterLeaveDoesNotRaise(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	// The abandoned objects come first, then the stale "now 1".
	for _, i := range []int{0, 1, 3, 2} {
		tr.HandleLine(lastLeaveLines[i])
	}
	if s := tr.Snapshot(); s.PlayersReported != 0 || len(s.Players) != 0 {
		t.Fatalf("players=%d reported=%d", len(s.Players), s.PlayersReported)
	}
}

func TestLeaveKeepsAConnectingClientCounted(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	for _, l := range []string{
		lastLeaveLines[0], lastLeaveLines[1],
		// PlayerB connects but is still loading: no character yet.
		`supervisord: valheim-server 10/16/2026 11:38:00: Player joined server "W" that has join code 123456, now 2 player(s)`,
		`supervisord: valheim-server 10/16/2026 11:39:00: Player connection lost server "W" that has join code 123456, now 2 player(s)`,
		lastLeaveLines[3],
	} {
		tr.HandleLine(l)
	}
	if s := tr.Snapshot(); s.PlayersReported != 1 || len(s.Players) != 0 {
		t.Fatalf("players=%d reported=%d", len(s.Players), s.PlayersReported)
	}
}

func TestNetStatsZeroConnectionsResetsCount(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	tr.HandleLine(lastLeaveLines[0])
	tr.HandleLine(lastLeaveLines[1])
	tr.HandleLine(`supervisord: valheim-server 10/16/2026 11:45:08:  Connections 1 ZDOS:500  sent:3 recv:40`)
	if s := tr.Snapshot(); s.PlayersReported != 1 || len(s.Players) != 1 {
		t.Fatalf("players=%d reported=%d", len(s.Players), s.PlayersReported)
	}
	tr.HandleLine(`supervisord: valheim-server 10/16/2026 11:55:08:  Connections 0 ZDOS:500  sent:0 recv:0`)
	if s := tr.Snapshot(); s.PlayersReported != 0 || len(s.Players) != 0 {
		t.Fatalf("players=%d reported=%d", len(s.Players), s.PlayersReported)
	}
}

// feed replays lines against a fake clock that starts at 12:00 UTC. A line
// that starts with "+" advances the clock by that duration instead.
func feed(t *testing.T, tr *Tracker, lines ...string) {
	t.Helper()
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	tr.now = func() time.Time { return now }
	for _, l := range lines {
		if strings.HasPrefix(l, "+") {
			d, err := time.ParseDuration(l[1:])
			if err != nil {
				t.Fatal(err)
			}
			now = now.Add(d)
			continue
		}
		tr.HandleLine("supervisord: valheim-server " + l)
	}
}

func platforms(tr *Tracker) map[string]string {
	got := map[string]string{}
	for _, p := range tr.Snapshot().Players {
		got[p.Name] = p.Platform
	}
	return got
}

// A Steam client completes the handshake and drops before spawning; an Xbox
// player then joins. The dropped connection's platform must not be lent to
// the Xbox player (#19).
func TestDroppedConnectionDoesNotLendPlatform(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`Player joined server "Midgard" that has join code 482915, now 1 player(s)`,
		`PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
		`Got handshake from client playfab/1B2C3D4E5F607182`,
		"+20s",
		`Keep socket for playfab/1B2C3D4E5F607182, try to reconnect before timeout`,
		`Player connection lost server "Midgard" that has join code 482915, now 1 player(s)`,
		"+10s",
		`Player joined server "Midgard" that has join code 482915, now 1 player(s)`,
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		`Got handshake from client playfab/0A1B2C3D4E5F6071`,
		"+30s",
		`Got character ZDOID from Ragnar : 111111111:1`,
	)
	if got, want := platforms(tr), map[string]string{"Ragnar": "xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("platforms = %v, want %v", got, want)
	}
}

// One connection that reconnects before spawning is one pending platform,
// not two: the second copy must not go to the next player who has none.
func TestReconnectBeforeSpawnQueuesOnePlatform(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		"+20s",
		`Keep socket for playfab/0A1B2C3D4E5F6071, try to reconnect before timeout`,
		"+10s",
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		// The same connection logs its platform again without a drop.
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		"+30s",
		`Got character ZDOID from Freya : -22222222:50`,
		// Bjorn's platform line was not captured: he must stay unknown.
		`Got character ZDOID from Bjorn : 333333333:10`,
	)
	if got, want := platforms(tr), map[string]string{"Freya": "xbox", "Bjorn": "unknown"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("platforms = %v, want %v", got, want)
	}
}

// Platforms of clients that never spawn expire with the TTL even when the
// count never reaches 0 (#25).
func TestStalePendingPlatformsArePruned(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`Got character ZDOID from Ragnar : 111111111:1`, // keeps the count above 0
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		"+1m",
		`PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
		"+1m",
		`PlayFab socket with remote ID playfab/2C3D4E5F60718293 received local Platform ID Steam_76561190000000004`,
		"+10m",
		`PlayFab socket with remote ID playfab/3D4E5F6071829304 received local Platform ID Xbox_2533274900000002`,
	)
	if len(tr.pending) != 1 || tr.pending[0].platform != "xbox" {
		t.Fatalf("pending = %+v", tr.pending)
	}
}

// Two players whose characters share a name (#23): the second one leaving
// must not take the name off the list while the first is still on, and the
// first one leaving later must still be seen.
func TestSameNameTwoPlayers(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`Player joined server "Midgard" that has join code 482915, now 1 player(s)`,
		`Got character ZDOID from Ragnar : 111111111:1`,
		"+5m",
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
		`Got character ZDOID from Ragnar : 333333333:10`,
		"+20m",
		`Destroying abandoned non persistent zdo 333333333:10 owner 333333333`,
		`Destroying abandoned non persistent zdo 333333333:11 owner 333333333`,
		`Player connection lost server "Midgard" that has join code 482915, now 1 player(s)`,
	)
	if s := tr.Snapshot(); len(s.Players) != 1 || s.Players[0].Name != "Ragnar" {
		t.Fatalf("after the second Ragnar left: players = %+v", s.Players)
	}
	feed(t, tr,
		`Destroying abandoned non persistent zdo 111111111:1 owner 111111111`,
		`Player connection lost server "Midgard" that has join code 482915, now 1 player(s)`,
	)
	if s := tr.Snapshot(); len(s.Players) != 0 {
		t.Fatalf("after both left: players = %+v", s.Players)
	}
	var seq []string
	for _, e := range drain(h) {
		switch e.Type {
		case "player_join":
			seq = append(seq, "+"+e.Data["name"].(string))
		case "player_leave":
			seq = append(seq, "-"+e.Data["name"].(string))
		}
	}
	if want := []string{"+Ragnar", "-Ragnar"}; !reflect.DeepEqual(seq, want) {
		t.Errorf("sequence = %v, want %v", seq, want)
	}
}
