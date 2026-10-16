// Package state folds parsed log lines and status-file reads into the
// server's current state, and publishes the resulting events. Notable events
// (everything except `log`, `world_saved`, `world_backup` and `raid`) fire on change only: the
// "is active with N player(s)" line repeats for the server's whole lifetime
// and the web persists every non-log, non-net_stats event.
package state

import (
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/events"
	"github.com/krystianslowik/skald/agent/internal/logparse"
)

const (
	StatusUnknown = "unknown"
	StatusRunning = "running"
)

type Player struct {
	Name  string    `json:"name"`
	Since time.Time `json:"since"`
	// Platform is xbox, steam, playstation, nintendo or unknown. The raw
	// platform user ID never leaves the parser.
	Platform string `json:"platform"`
}

// platformTTL bounds how long a connecting client's platform waits for its
// character. Loading into the world took about 30 s in the captured session.
const platformTTL = 3 * time.Minute

type pendingPlatform struct {
	// remote is the connection's PlayFab remote id; "" when the line had
	// none. It stays inside the tracker.
	remote   string
	platform string
	at       time.Time
}

// NetStats is the latest "Connections N ZDOS:..." summary.
type NetStats struct {
	Connections int `json:"connections"`
	ZDOs        int `json:"zdos"`
	Sent        int `json:"sent"`
	Recv        int `json:"recv"`
}

// Snapshot is the log- and status-file-derived part of GET /state.
type Snapshot struct {
	Status          string
	Version         string
	NetworkVersion  int
	JoinCode        string
	JoinCodeAt      *time.Time
	PlayersReported int
	Playfab         string
	Players         []Player
	LastSaveAt      *time.Time
	LastSaveMs      float64
	LastLogAt       *time.Time
	NetStats        *NetStats
}

type Tracker struct {
	mu  sync.Mutex
	hub *events.Hub
	now func() time.Time
	s   Snapshot

	// uids maps an online character's peer id to its name; current is the
	// reverse: every peer id online under a name. A name holds several while
	// a reconnect's old peer is not cleaned up yet, or when two players'
	// characters share the name. The name leaves when its last peer does.
	uids    map[string]string
	current map[string]map[string]struct{}
	// pending platforms of open connections, oldest first, at most one per
	// remote id, waiting for a character to claim them.
	pending []pendingPlatform
}

func New(hub *events.Hub) *Tracker {
	return &Tracker{
		hub: hub,
		now: time.Now,
		s:   Snapshot{Playfab: StatusUnknown, Players: []Player{}},

		uids:    map[string]string{},
		current: map[string]map[string]struct{}{},
	}
}

// HandleLine processes one raw syslog line: publishes it as a `log` event,
// then applies every match from the parser table.
func (t *Tracker) HandleLine(raw string) {
	line, matches := logparse.Parse(raw)

	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now().UTC()
	t.s.LastLogAt = &now
	t.hub.Publish("log", map[string]any{"line": logparse.Redact(line.Text), "program": line.Program})

	for _, m := range matches {
		switch m.Kind {
		case logparse.KindVersion:
			if m.Version != t.s.Version || m.NetworkVersion != t.s.NetworkVersion {
				t.s.Version, t.s.NetworkVersion = m.Version, m.NetworkVersion
				t.hub.Publish("version", map[string]any{"version": m.Version, "networkVersion": m.NetworkVersion})
			}
		case logparse.KindJoinCode:
			if m.Code != t.s.JoinCode {
				t.s.JoinCode = m.Code
				t.s.JoinCodeAt = &now
				t.hub.Publish("join_code", map[string]any{"code": m.Code})
			}
		case logparse.KindPlayerCount:
			n := m.Count
			if m.Lost && n > t.s.PlayersReported {
				// The connection-lost count can lag by one: it may lower
				// the count, never raise it. The leave lowers it.
				n = t.s.PlayersReported
			}
			t.setCount(n)
		case logparse.KindPlayfab:
			if m.State != t.s.Playfab {
				t.s.Playfab = m.State
				t.hub.Publish("playfab", map[string]any{"state": m.State})
			}
		case logparse.KindPlatform:
			// A reconnect, or a repeated line, replaces the connection's
			// entry rather than queueing a second one.
			t.dropPending(m.Remote, now)
			t.pending = append(t.pending, pendingPlatform{remote: m.Remote, platform: m.Platform, at: now})
		case logparse.KindSocketLost:
			if m.Remote != "" {
				t.dropPending(m.Remote, now)
			}
		case logparse.KindCharacter:
			if m.Death {
				// A death line also proves the player is online, so join
				// first. It carries no peer id: the uid maps stay as they are.
				t.join(m.Name, "", now)
				t.hub.Publish("death", map[string]any{"name": m.Name})
				continue
			}
			if old, ok := t.uids[m.UID]; ok && old != m.Name {
				t.dropPeer(m.UID) // a peer id is one connection; never seen renamed
			}
			if t.current[m.Name] == nil {
				t.current[m.Name] = map[string]struct{}{}
			}
			t.uids[m.UID] = m.Name
			t.current[m.Name][m.UID] = struct{}{}
			t.join(m.Name, t.claimPlatform(now), now)
		case logparse.KindAbandoned:
			// One line per object the peer owned; the first one is the
			// peer's leave. Its character is one of them, so every peer that
			// spawned gets one.
			t.dropPeer(m.UID)
		case logparse.KindWorldBackup:
			t.hub.Publish("world_backup", map[string]any{"ms": m.Ms})
		case logparse.KindWorldSaved:
			t.s.LastSaveAt = &now
			t.s.LastSaveMs = m.Ms
			t.hub.Publish("world_saved", map[string]any{"ms": m.Ms})
		case logparse.KindRaid:
			t.hub.Publish("raid", map[string]any{"name": m.Name})
		case logparse.KindNetStats:
			ns := NetStats{Connections: m.Connections, ZDOs: m.ZDOs, Sent: m.Sent, Recv: m.Recv}
			// sent/recv move on every line; only a connection or ZDO count
			// change is worth an event.
			changed := t.s.NetStats == nil || t.s.NetStats.Connections != ns.Connections || t.s.NetStats.ZDOs != ns.ZDOs
			t.s.NetStats = &ns
			if changed {
				t.hub.Publish("net_stats", map[string]any{"connections": ns.Connections, "zdos": ns.ZDOs, "sent": ns.Sent, "recv": ns.Recv})
			}
			if ns.Connections == 0 {
				// The game's own 10-minute summary: nobody is connected.
				t.setCount(0)
			}
		}
	}
}

// SetStatus applies the content of the shared status file. Leaving `running`
// clears the player list: a stop or restart kicks everyone.
func (t *Tracker) SetStatus(status string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if status == t.s.Status {
		return
	}
	t.s.Status = status
	t.hub.Publish("server_state", map[string]any{"status": status})
	if status != StatusRunning {
		t.setCount(0)
	}
}

// Snapshot returns a copy safe to marshal without holding the lock.
func (t *Tracker) Snapshot() Snapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.s
	s.Players = append([]Player{}, t.s.Players...)
	if t.s.NetStats != nil {
		ns := *t.s.NetStats
		s.NetStats = &ns
	}
	if s.Status == "" {
		s.Status = StatusUnknown
	}
	return s
}

// dropPeer forgets one peer id and takes its name off the list once no other
// peer is online under it. Caller holds mu.
func (t *Tracker) dropPeer(uid string) {
	name, ok := t.uids[uid]
	if !ok {
		return
	}
	delete(t.uids, uid)
	peers := t.current[name]
	delete(peers, uid)
	if len(peers) == 0 {
		delete(t.current, name)
		t.leave(name)
	}
}

// dropPending removes expired platforms and the entry of one connection
// ("" removes none), so the queue holds only recent, open connections
// whatever the player count does. Caller holds mu.
func (t *Tracker) dropPending(remote string, now time.Time) {
	kept := t.pending[:0]
	for _, p := range t.pending {
		if now.Sub(p.at) <= platformTTL && (remote == "" || p.remote != remote) {
			kept = append(kept, p)
		}
	}
	clear(t.pending[len(kept):])
	t.pending = kept
}

// claimPlatform takes the oldest unexpired platform of a connection still
// open. The ZDOID line carries no PlayFab id, so among open connections
// arrival order is all there is to match on. Caller holds mu.
func (t *Tracker) claimPlatform(now time.Time) string {
	t.dropPending("", now)
	if len(t.pending) == 0 {
		return logparse.PlatformUnknown
	}
	p := t.pending[0]
	t.pending = t.pending[1:]
	return p.platform
}

// join adds a player unless already online; a known platform fills in an
// unknown one. Caller holds mu.
func (t *Tracker) join(name, platform string, now time.Time) {
	for i, p := range t.s.Players {
		if p.Name == name {
			if platform != "" && platform != logparse.PlatformUnknown && p.Platform != platform {
				t.s.Players[i].Platform = platform
			}
			return
		}
	}
	if platform == "" {
		platform = logparse.PlatformUnknown
	}
	t.s.Players = append(t.s.Players, Player{Name: name, Since: now, Platform: platform})
	t.hub.Publish("player_join", map[string]any{"name": name, "platform": platform})
}

// leave removes one name and takes it off the reported count, which
// the lagging connection-lost line leaves one too high. The count stays at
// least the number still listed. Caller holds mu.
func (t *Tracker) leave(name string) {
	for i, p := range t.s.Players {
		if p.Name == name {
			t.s.Players = append(t.s.Players[:i:i], t.s.Players[i+1:]...)
			t.hub.Publish("player_leave", map[string]any{"name": name})
			if n := max(t.s.PlayersReported-1, len(t.s.Players)); n < t.s.PlayersReported {
				t.s.PlayersReported = n
				t.hub.Publish("player_count", map[string]any{"count": n})
			}
			return
		}
	}
}

// setCount records the server-reported player count. Per-player leaves come
// from abandoned-object lines; a drop to 0 is the safety net and emits
// player_leave for everyone still listed. Caller holds mu.
func (t *Tracker) setCount(n int) {
	if n != t.s.PlayersReported {
		t.s.PlayersReported = n
		t.hub.Publish("player_count", map[string]any{"count": n})
	}
	if n == 0 && len(t.s.Players) > 0 {
		for _, p := range t.s.Players {
			t.hub.Publish("player_leave", map[string]any{"name": p.Name})
		}
		t.s.Players = []Player{}
	}
	if n == 0 {
		clear(t.uids)
		clear(t.current)
		t.pending = nil
	}
}
