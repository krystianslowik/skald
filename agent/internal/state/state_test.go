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
	if s.VersionAt == nil || s.WorldLoadedAt == nil || s.JoinCodeSeenAt == nil || s.WorldLoadedAt.Before(*s.VersionAt) {
		t.Errorf("startup marks = version %v, world loaded %v, join code %v", s.VersionAt, s.WorldLoadedAt, s.JoinCodeSeenAt)
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
	// The clock goes on from an earlier feed of this tracker.
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	if prev := tr.now(); !prev.Before(now) && prev.Before(now.Add(24*time.Hour)) {
		now = prev
	}
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

// A respawn after a death is the same connection: it must not take the
// platform of a client that is still loading.
func TestRespawnDoesNotClaimAnotherPlatform(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		"+30s",
		`Got character ZDOID from Ragnar : 111111111:1`,
		"+10m",
		`PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
		"+5s",
		`Got character ZDOID from Ragnar : 0:0`,
		"+8s",
		`Got character ZDOID from Ragnar : 111111111:2`,
		"+10s",
		`Got character ZDOID from Bjorn : 333333333:10`,
	)
	if got, want := platforms(tr), map[string]string{"Ragnar": "xbox", "Bjorn": "steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("platforms = %v, want %v", got, want)
	}
}

// A client's platform survives a count of 0 that arrives while it loads:
// the count can lag, and the entry expires on its own.
func TestPendingPlatformSurvivesCountZero(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		`Player connection lost server "Midgard" that has join code 482915, now 0 player(s)`,
		"+30s",
		`Got character ZDOID from Freya : -22222222:50`,
	)
	if got, want := platforms(tr), map[string]string{"Freya": "xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("platforms = %v, want %v", got, want)
	}
	tr.SetStatus("stopping")
	if len(tr.pending) != 0 {
		t.Fatalf("pending after stop = %+v", tr.pending)
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

// Two players whose characters share a name (#23): the second one gets its
// own entry, and each leaves on its own.
// Two players whose characters share a name. The log alone cannot tell a
// second player from a reconnect whose old peer is not cleaned up yet, so it
// lists one entry (a missed split, never a phantom player). The admin plugin
// lists both peers alive, which splits them (#23).
func TestSameNameTwoPlayers(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`Player joined server "Midgard" that has join code 482915, now 1 player(s)`,
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		"+30s",
		`Got character ZDOID from Ragnar : 111111111:1`,
		"+5m",
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
		`PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
		"+30s",
		`Got character ZDOID from Ragnar : 333333333:10`,
	)
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("log only: players = %v, want %v", got, want)
	}
	if !tr.PeersWanted() {
		t.Fatal("two peers under one player: the plugin list is wanted")
	}
	tr.SetPeers(after(tr), []Peer{{"111111111", "Ragnar", "xbox", "acct-111111111"}, {"333333333", "Ragnar", "steam", "acct-333333333"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox", "Ragnar#2": "Ragnar/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("with the plugin: players = %v, want %v", got, want)
	}
	if tr.PeersWanted() {
		t.Fatal("every peer is confirmed: no more plugin reads wanted")
	}
	feed(t, tr,
		`Destroying abandoned non persistent zdo 333333333:10 owner 333333333`,
		`Destroying abandoned non persistent zdo 333333333:11 owner 333333333`,
		// The connection-lost count lags by one.
		`Player connection lost server "Midgard" that has join code 482915, now 2 player(s)`,
	)
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after the second Ragnar left: players = %v, want %v", got, want)
	}
	if s := tr.Snapshot(); s.PlayersReported != 1 {
		t.Fatalf("after the second Ragnar left: reported = %d", s.PlayersReported)
	}
	feed(t, tr,
		`Destroying abandoned non persistent zdo 111111111:1 owner 111111111`,
		`Player connection lost server "Midgard" that has join code 482915, now 1 player(s)`,
	)
	if s := tr.Snapshot(); len(s.Players) != 0 {
		t.Fatalf("after both left: players = %+v", s.Players)
	}
	if want := []string{"+Ragnar=Ragnar", "+Ragnar=Ragnar#2", "-Ragnar=Ragnar#2", "-Ragnar=Ragnar"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
}

// A reconnect while another client is still loading: the count includes the
// loading client, so it must not make the reconnect a second "Ragnar#2".
func TestReconnectWhileAnotherLoadsIsNoNewPlayer(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`Player joined server "Midgard" that has join code 482915, now 1 player(s)`,
		`Got character ZDOID from Ragnar : 100:1`,
		"+5m",
		// Freya connects and is still loading.
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
		"+10s",
		// Ragnar reconnects before his old peer's abandoned lines.
		`Got character ZDOID from Ragnar : 200:1`,
	)
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/unknown"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	// The plugin no longer lists the old peer: it expires without a leave.
	tr.SetPeers(after(tr), []Peer{{"200", "Ragnar", "steam", "acct-200"}, {"300", "Freya", "xbox", "acct-300"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after the plugin read: players = %v, want %v", got, want)
	}
	feed(t, tr, `Destroying abandoned non persistent zdo 100:1 owner 100`)
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after the old peer's abandoned lines: players = %v, want %v", got, want)
	}
	if want := []string{"+Ragnar=Ragnar"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
}

// The second of two same-name players reconnects before its old peer is
// cleaned up. The log attaches the new peer to the first Ragnar; the plugin
// read hands it back to the second one, which never leaves.
func TestSameNameSecondPlayerReconnects(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`Got character ZDOID from Ragnar : 100:1`,
		`Got character ZDOID from Ragnar : 200:1`,
	)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "acct-100"}, {"200", "Ragnar", "steam", "acct-200"}})
	feed(t, tr,
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
		"+1m",
		`Got character ZDOID from Ragnar : 300:1`,
	)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "acct-100"}, {"300", "Ragnar", "steam", "acct-200"}})
	feed(t, tr,
		`Destroying abandoned non persistent zdo 200:1 owner 200`,
		`Player connection lost server "Midgard" that has join code 482915, now 2 player(s)`,
	)
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox", "Ragnar#2": "Ragnar/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if s := tr.Snapshot(); s.PlayersReported != 2 {
		t.Fatalf("reported = %d, want 2", s.PlayersReported)
	}
	if want := []string{"+Ragnar=Ragnar", "+Ragnar=Ragnar#2"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
	// Each one's own leave still works.
	feed(t, tr, `Destroying abandoned non persistent zdo 300:1 owner 300`)
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after the second Ragnar left: players = %v, want %v", got, want)
	}
}

// A name already listed from a death line (the agent started mid-session)
// is the same player when that character spawns, not a second one.
func TestSpawnAfterDeathLineIsOnePlayer(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`Session "Midgard" with join code 482915 and IP 203.0.113.10:2456 is active with 1 player(s)`,
		`Got character ZDOID from Freya : 0:0`,
		"+8s",
		`Got character ZDOID from Freya : -22222222:20111`,
	)
	if got, want := byID(tr), map[string]string{"Freya": "Freya/unknown"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if want := []string{"+Freya=Freya"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
}

// With the admin plugin, the platform the game reports for a peer wins over
// the arrival-order guess (#19): a Steam client that stays connected
// without spawning must not leave its platform on the Xbox player, nor take
// the Xbox player's when it spawns later.
func TestBridgePlatformWins(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`Player joined server "Midgard" that has join code 482915, now 1 player(s)`,
		`PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
		"+40s",
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		"+30s",
		`Got character ZDOID from Ragnar : 111111111:1`,
	)
	// The log alone guesses wrong: the stuck Steam client came first.
	if got := byID(tr); got["Ragnar"] != "Ragnar/steam" {
		t.Fatalf("log guess = %v", got)
	}
	if !tr.PeersWanted() {
		t.Fatal("an unconfirmed peer: the plugin list is wanted")
	}
	// The plugin lists the loading client too, without a character.
	tr.SetPeers(after(tr), []Peer{{"111111111", "Ragnar", "xbox", "acct-111111111"}, {"555", "Freya", "steam", "acct-555"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if tr.PeersWanted() {
		t.Fatal("every peer confirmed: no plugin read wanted")
	}
	var fixed []map[string]any
	for _, e := range drain(h) {
		if e.Type == "player_platform" {
			fixed = append(fixed, e.Data)
		}
	}
	if want := []map[string]any{{"name": "Ragnar", "id": "Ragnar", "platform": "xbox"}}; !reflect.DeepEqual(fixed, want) {
		t.Fatalf("player_platform events = %v, want %v", fixed, want)
	}
	// Repeating the same report changes nothing and publishes nothing.
	tr.SetPeers(after(tr), []Peer{{"111111111", "Ragnar", "xbox", "acct-111111111"}, {"555", "Freya", "steam", "acct-555"}})
	if n := types(drain(h))["player_platform"]; n != 1 {
		t.Fatalf("player_platform events after a repeated report = %d, want 1", n)
	}
	// Unknown never overwrites a known platform.
	tr.SetPeers(after(tr), []Peer{{"111111111", "Ragnar", "unknown", "acct-111111111"}})
	if got := byID(tr); got["Ragnar"] != "Ragnar/xbox" {
		t.Fatalf("after an unknown report: %v", got)
	}
	// The stuck client spawns at last: the log hands it whatever is left in
	// the queue (the Xbox line Ragnar did not use), the plugin corrects it.
	feed(t, tr, "+1m", `Got character ZDOID from Freya : 555:1`)
	if !tr.PeersWanted() {
		t.Fatal("a new peer: the plugin list is wanted")
	}
	tr.SetPeers(after(tr), []Peer{{"111111111", "Ragnar", "xbox", "acct-111111111"}, {"555", "Freya", "steam", "acct-555"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox", "Freya": "Freya/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after Freya spawned: players = %v, want %v", got, want)
	}
}

// One entry with two live peers on different platforms is two players the
// log took for a reconnect: the plugin splits them, each with its platform.
func TestBridgePlatformDisagreementSplits(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`PlayFab socket with remote ID playfab/0A1B2C3D4E5F6071 received local Platform ID Xbox_2533274900000001`,
		`Got character ZDOID from Ragnar : 100:1`,
		`Got character ZDOID from Ragnar : 200:1`,
	)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "steam", "acct-100"}, {"200", "Ragnar", "playstation", "acct-200"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/steam", "Ragnar#2": "Ragnar/playstation"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
}

// A peer the log reported after the plugin read began is not judged by it:
// the read may have been taken before that peer connected.
func TestPeerNewerThanTheReadIsKept(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`)
	readAt := after(tr)
	feed(t, tr, "+2s", `Got character ZDOID from Freya : 200:1`)
	tr.SetPeers(readAt, []Peer{{"100", "Ragnar", "xbox", "acct-100"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox", "Freya": "Freya/unknown"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if !tr.PeersWanted() {
		t.Fatal("Freya's peer is not confirmed yet")
	}
}

// A reconnect while the server still holds the old peer: the plugin lists
// both under one account. That is one player, not two, and its platform
// comes from the new peer.
func TestReconnectStillListedIsOnePlayer(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr,
		`Got character ZDOID from Ragnar : 100:1`,
		"+1m",
		`Got character ZDOID from Ragnar : 200:1`,
	)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "acct-1"}, {"200", "Ragnar", "xbox", "acct-1"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	// The old peer times out; the plugin lists only the new one.
	tr.SetPeers(after(tr), []Peer{{"200", "Ragnar", "xbox", "acct-1"}})
	feed(t, tr, `Destroying abandoned non persistent zdo 100:1 owner 100`)
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("after the old peer went: players = %v, want %v", got, want)
	}
	if want := []string{"+Ragnar=Ragnar"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
	if tr.PeersWanted() {
		t.Fatal("settled: no plugin read wanted")
	}
}

// The second of two same-name players reconnects while the plugin still
// lists its old peer; the log attached the new peer to the first Ragnar.
// The new peer goes back to its account's player, no phantom "Ragnar#3".
func TestSecondPlayerReconnectStillListed(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`, `Got character ZDOID from Ragnar : 200:1`)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}})
	feed(t, tr, "+1m", `Got character ZDOID from Ragnar : 300:1`)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}, {"300", "Ragnar", "steam", "B"}})
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"300", "Ragnar", "steam", "B"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox", "Ragnar#2": "Ragnar/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if want := []string{"+Ragnar=Ragnar", "+Ragnar=Ragnar#2"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
	if got := tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"300", "Ragnar", "steam", "B"}}); got.ByUID["300"] != "Ragnar#2" {
		t.Errorf("ids = %v", got.ByUID)
	}
}

// Expiring a reconnect's stale peer leaves the count to the game's count
// lines: a client still loading stays counted.
func TestExpiringAStalePeerKeepsTheCount(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`Got character ZDOID from Ragnar : 100:1`,
		`Got character ZDOID from Freya : 400:1`,
		`Player joined server "Midgard" that has join code 482915, now 3 player(s)`,
		"+1m",
		`Got character ZDOID from Ragnar : 200:1`,
	)
	tr.SetPeers(after(tr), []Peer{{"200", "Ragnar", "xbox", "A"}, {"400", "Freya", "steam", "F"}, {"500", "", "steam", "L"}})
	if s := tr.Snapshot(); s.PlayersReported != 3 || len(s.Players) != 2 {
		t.Fatalf("reported = %d, players = %+v", s.PlayersReported, s.Players)
	}
}

// A player the plugin read already took off the list: its abandoned lines
// still lower the lagging connection-lost count, once.
func TestAbandonAfterExpiryLowersTheCount(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`Got character ZDOID from Ragnar : 100:1`,
		`Got character ZDOID from Freya : 400:1`,
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
	)
	tr.SetPeers(after(tr), []Peer{{"400", "Freya", "steam", "F"}})
	feed(t, tr,
		// The connection-lost count lags by one.
		`Player connection lost server "Midgard" that has join code 482915, now 2 player(s)`,
		`Destroying abandoned non persistent zdo 100:1 owner 100`,
		`Destroying abandoned non persistent zdo 100:2 owner 100`,
	)
	if s := tr.Snapshot(); s.PlayersReported != 1 || len(s.Players) != 1 {
		t.Fatalf("reported = %d, players = %+v", s.PlayersReported, s.Players)
	}
}

// A player whose only live peer the plugin lists under another name is not
// left without one: a spare same-name peer is a new player, not its.
func TestPeerUnderAnotherNameIsNotAnOrphan(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`, `Got character ZDOID from Ragnar : 200:1`)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}})
	feed(t, tr, "+1m",
		`PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
		`Got character ZDOID from Ragnar : 300:1`,
	)
	// 300 went to Ragnar#2 (steam). The plugin names 100 differently for once.
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar ", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}, {"300", "Ragnar", "playstation", "C"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox", "Ragnar#2": "Ragnar/steam", "Ragnar#3": "Ragnar/playstation"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
}

// A player's account is remembered from earlier reads: its own peer
// reporting none for once (dead, respawning) does not make it keep the
// reconnect the log attached to it by mistake.
func TestAccountRememberedWhenAPeerReportsNone(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`, `Got character ZDOID from Ragnar : 200:1`)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}})
	feed(t, tr, "+1m", `Got character ZDOID from Ragnar : 300:1`)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", ""}, {"300", "Ragnar", "steam", "B"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/xbox", "Ragnar#2": "Ragnar/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if want := []string{"+Ragnar=Ragnar", "+Ragnar=Ragnar#2"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
}

// A peer a read missed and the log brings back is not expired any more:
// its leave lowers the count once.
func TestPeerBackAfterExpiryLowersTheCountOnce(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`Got character ZDOID from Ragnar : 100:1`,
		`Got character ZDOID from Freya : 400:1`,
		// Three with a client still loading.
		`Player joined server "Midgard" that has join code 482915, now 3 player(s)`,
	)
	tr.SetPeers(after(tr), []Peer{{"400", "Freya", "steam", "F"}})
	feed(t, tr, "+1m",
		`Got character ZDOID from Ragnar : 100:2`,
		`Destroying abandoned non persistent zdo 100:2 owner 100`,
	)
	if s := tr.Snapshot(); s.PlayersReported != 2 {
		t.Fatalf("reported = %d, want 2", s.PlayersReported)
	}
}

// A player listed without a peer (from a death line) is no id the bridge
// must avoid: the plugin's peer for that character gets it.
func TestPeerlessPlayerIDIsNotInUse(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Freya : 0:0`, `Got character ZDOID from Ragnar : 100:1`)
	got := tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"400", "Freya", "steam", "F"}})
	if want := []string{"Ragnar"}; !reflect.DeepEqual(got.InUse, want) {
		t.Fatalf("in use = %v, want %v", got.InUse, want)
	}
}

// An orphan known by one account does not take an unrelated account's
// peers: that is another person, a leave and a join.
func TestOrphanKnownByAnotherAccountIsNotReused(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`, `Got character ZDOID from Ragnar : 200:1`)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}})
	// A leaves (100 gone, its lines not yet), C joins and the log puts it
	// on the steam Ragnar.
	feed(t, tr, "+1m",
		`PlayFab socket with remote ID playfab/1B2C3D4E5F607182 received local Platform ID Steam_76561190000000003`,
		`Got character ZDOID from Ragnar : 300:1`,
	)
	tr.SetPeers(after(tr), []Peer{{"200", "Ragnar", "steam", "B"}, {"300", "Ragnar", "playstation", "C"}})
	if got, want := byID(tr), map[string]string{"Ragnar#2": "Ragnar/steam", "Ragnar": "Ragnar/playstation"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if want := []string{"+Ragnar=Ragnar", "+Ragnar=Ragnar#2", "-Ragnar=Ragnar", "+Ragnar=Ragnar"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
}

// One Ragnar leaves and another account's Ragnar joins before the old
// peer's lines: a leave and a join, and the newcomer is plain "Ragnar".
func TestTakeOverBySoleNewAccountKeepsThePlainID(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`)
	tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}})
	feed(t, tr, "+1m", `Got character ZDOID from Ragnar : 200:1`)
	tr.SetPeers(after(tr), []Peer{{"200", "Ragnar", "steam", "B"}})
	if got, want := byID(tr), map[string]string{"Ragnar": "Ragnar/steam"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("players = %v, want %v", got, want)
	}
	if want := []string{"+Ragnar=Ragnar", "-Ragnar=Ragnar", "+Ragnar=Ragnar"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
}

// The plugin's ids: one peer per player carries the player's id; a
// reconnect's old peer of the same account is hidden; peers the tracker
// cannot tell apart (no account, or newer than the read) get none.
func TestSetPeersNamesOnePeerPerPlayer(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`, `Got character ZDOID from Freya : 400:1`, `Got character ZDOID from Freya : 500:1`)
	readAt := after(tr)
	feed(t, tr, "+2s", `Got character ZDOID from Ragnar : 200:1`)
	got := tr.SetPeers(readAt, []Peer{{"100", "Ragnar", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}, {"400", "Freya", "steam", ""}, {"500", "Freya", "steam", ""}})
	// Freya's two peers have no account: the newer carries the id.
	if want := map[string]string{"100": "Ragnar", "500": "Freya"}; !reflect.DeepEqual(got.ByUID, want) {
		t.Fatalf("ids = %v, want %v", got.ByUID, want)
	}
	if len(got.Hidden) != 0 {
		t.Fatalf("hidden = %v", got.Hidden)
	}
	// Ragnar reconnects as 300 on account A while the server still lists 100.
	feed(t, tr, "+1m", `Got character ZDOID from Ragnar : 300:1`)
	got = tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "A"}, {"300", "Ragnar", "xbox", "A"}, {"200", "Ragnar", "steam", "B"}})
	if got.ByUID["300"] != "Ragnar" || got.ByUID["200"] != "Ragnar#2" || !got.Hidden["100"] {
		t.Fatalf("ids = %v, hidden = %v", got.ByUID, got.Hidden)
	}
}

// A count line that is not a connection-lost line is the truth: an
// expired peer's abandoned lines after it do not lower it again; nor do
// they after the expiry's wait.
func TestExpiredPeerAfterACountLine(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr,
		`Got character ZDOID from Ragnar : 100:1`,
		`Got character ZDOID from Freya : 400:1`,
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
	)
	tr.SetPeers(after(tr), []Peer{{"400", "Freya", "steam", "F"}})
	feed(t, tr,
		`Player joined server "Midgard" that has join code 482915, now 2 player(s)`,
		`Destroying abandoned non persistent zdo 100:1 owner 100`,
	)
	if s := tr.Snapshot(); s.PlayersReported != 2 {
		t.Fatalf("after a count line: reported = %d, want 2", s.PlayersReported)
	}
	feed(t, tr, `Got character ZDOID from Bjorn : 600:1`)
	tr.SetPeers(after(tr), []Peer{{"400", "Freya", "steam", "F"}})
	feed(t, tr, "+11m", `Destroying abandoned non persistent zdo 600:1 owner 600`)
	if s := tr.Snapshot(); s.PlayersReported != 2 {
		t.Fatalf("after the wait: reported = %d, want 2", s.PlayersReported)
	}
}

// Without accounts, a reconnect's newer peer carries the player's id; a
// read older than one already taken changes nothing and re-lists no peer
// that read expired.
func TestNewestPeerAndOutOfOrderReads(t *testing.T) {
	h := events.New(100, 100)
	tr := New(h)
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`, "+1m", `Got character ZDOID from Ragnar : 200:1`)
	old := after(tr)
	got := tr.SetPeers(old, []Peer{{"100", "Ragnar", "xbox", ""}, {"200", "Ragnar", "xbox", ""}})
	if want := map[string]string{"200": "Ragnar"}; !reflect.DeepEqual(got.ByUID, want) {
		t.Fatalf("ids = %v, want %v", got.ByUID, want)
	}
	newer := old.Add(time.Second)
	tr.SetPeers(newer, []Peer{{"200", "Ragnar", "xbox", ""}})
	got = tr.SetPeers(old, []Peer{{"100", "Ragnar", "xbox", ""}, {"200", "Ragnar", "xbox", ""}})
	if !got.Hidden["100"] || got.ByUID["200"] != "Ragnar" {
		t.Fatalf("late read: ids = %v, hidden = %v", got.ByUID, got.Hidden)
	}
	if want := []string{"+Ragnar=Ragnar"}; !reflect.DeepEqual(joinsLeaves(h), want) {
		t.Errorf("sequence = %v, want %v", joinsLeaves(h), want)
	}
}

// SetPeers hands back the id of each listed peer the tracker knows.
func TestSetPeersReturnsIDs(t *testing.T) {
	tr := New(events.New(100, 100))
	tr.SetStatus("running")
	feed(t, tr, `Got character ZDOID from Ragnar : 100:1`, `Got character ZDOID from Ragnar : 200:1`)
	got := tr.SetPeers(after(tr), []Peer{{"100", "Ragnar", "xbox", "a"}, {"200", "Ragnar", "steam", "b"}, {"300", "Freya", "steam", "c"}})
	if want := map[string]string{"100": "Ragnar", "200": "Ragnar#2"}; !reflect.DeepEqual(got.ByUID, want) {
		t.Fatalf("ids = %v, want %v", got.ByUID, want)
	}
	if want := []string{"Ragnar", "Ragnar#2"}; !reflect.DeepEqual(got.InUse, want) {
		t.Fatalf("in use = %v, want %v", got.InUse, want)
	}
}

// after is a plugin read time later than every line fed so far.
func after(tr *Tracker) time.Time { return tr.now().Add(time.Second) }

// byID maps every listed player's id to "name/platform".
func byID(tr *Tracker) map[string]string {
	got := map[string]string{}
	for _, p := range tr.Snapshot().Players {
		got[p.ID] = p.Name + "/" + p.Platform
	}
	return got
}

// joinsLeaves is the hub's join and leave events as "+name=id" / "-name=id".
func joinsLeaves(h *events.Hub) []string {
	var seq []string
	for _, e := range drain(h) {
		id, _ := e.Data["id"].(string)
		switch e.Type {
		case "player_join":
			seq = append(seq, "+"+e.Data["name"].(string)+"="+id)
		case "player_leave":
			seq = append(seq, "-"+e.Data["name"].(string)+"="+id)
		}
	}
	return seq
}
