// Package state folds parsed log lines and status-file reads into the
// server's current state, and publishes the resulting events. Notable events
// (everything except `log`, `world_saved` and `raid`) fire on change only: the
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
}

func New(hub *events.Hub) *Tracker {
	return &Tracker{
		hub: hub,
		now: time.Now,
		s:   Snapshot{Playfab: StatusUnknown, Players: []Player{}},
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
	t.hub.Publish("log", map[string]any{"line": line.Text, "program": line.Program})

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
			t.setCount(m.Count)
		case logparse.KindPlayfab:
			if m.State != t.s.Playfab {
				t.s.Playfab = m.State
				t.hub.Publish("playfab", map[string]any{"state": m.State})
			}
		case logparse.KindCharacter:
			// A death line also proves the player is online, so join first.
			t.join(m.Name, now)
			if m.Death {
				t.hub.Publish("death", map[string]any{"name": m.Name})
			}
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

// join adds a player unless already online. Caller holds mu.
func (t *Tracker) join(name string, now time.Time) {
	for _, p := range t.s.Players {
		if p.Name == name {
			return
		}
	}
	t.s.Players = append(t.s.Players, Player{Name: name, Since: now})
	t.hub.Publish("player_join", map[string]any{"name": name})
}

// setCount records the server-reported player count. Leave detection is
// count-based only: a drop to 0 emits player_leave for everyone online.
// Caller holds mu.
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
}
