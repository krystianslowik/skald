// Package state folds parsed log lines and status-file reads into the
// server's current state, and publishes the resulting events. Notable events
// (everything except `log`, `world_saved`, `world_backup` and `raid`) fire on change only: the
// "is active with N player(s)" line repeats for the server's whole lifetime
// and the web persists every non-log, non-net_stats event.
package state

import (
	"slices"
	"strconv"
	"strings"
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
	// ID tells apart players online at once whose characters share a name:
	// the name itself, then "Ragnar#2", "Ragnar#3" for the next ones. It is
	// never a platform or peer id.
	ID    string    `json:"id"`
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
	// VersionAt is when the game last logged its version line, also when the
	// version stayed the same: the start of the game process as the log tells
	// it. WorldLoadedAt is the last "Loading: Done" line, JoinCodeSeenAt the
	// last line carrying a join code. They are for the compatibility check
	// and are not part of /state.
	VersionAt      *time.Time
	WorldLoadedAt  *time.Time
	JoinCodeSeenAt *time.Time
}

type Tracker struct {
	mu  sync.Mutex
	hub *events.Hub
	now func() time.Time
	s   Snapshot

	// uids maps an online character's peer id to its player's ID; peers is
	// the reverse: every peer id online under a player. A player holds
	// several while a reconnect's old peer is not cleaned up yet. The player
	// leaves when its last peer does.
	uids  map[string]string
	peers map[string]map[string]struct{}
	// seen is when the log first put each peer id on its player; confirmed
	// holds the peer ids a plugin player list taken after that has listed.
	seen      map[string]time.Time
	confirmed map[string]struct{}
	// pending platforms of open connections, oldest first, at most one per
	// remote id, waiting for a character to claim them.
	pending []pendingPlatform
}

func New(hub *events.Hub) *Tracker {
	return &Tracker{
		hub: hub,
		now: time.Now,
		s:   Snapshot{Playfab: StatusUnknown, Players: []Player{}},

		uids:      map[string]string{},
		peers:     map[string]map[string]struct{}{},
		seen:      map[string]time.Time{},
		confirmed: map[string]struct{}{},
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
			t.s.VersionAt = &now
			if m.Version != t.s.Version || m.NetworkVersion != t.s.NetworkVersion {
				t.s.Version, t.s.NetworkVersion = m.Version, m.NetworkVersion
				t.hub.Publish("version", map[string]any{"version": m.Version, "networkVersion": m.NetworkVersion})
			}
		case logparse.KindWorldLoaded:
			t.s.WorldLoadedAt = &now
		case logparse.KindJoinCode:
			t.s.JoinCodeSeenAt = &now
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
				if t.byName(m.Name) < 0 {
					t.join(m.Name, logparse.PlatformUnknown, now)
				}
				t.hub.Publish("death", map[string]any{"name": m.Name})
				continue
			}
			if id, known := t.uids[m.UID]; known {
				if i := t.index(id); i >= 0 && t.s.Players[i].Name == m.Name {
					// A respawn: same connection, whose platform was claimed
					// at its first spawn. Claiming again would take another
					// client's.
					continue
				}
				// A peer id is one connection; never seen renamed. Move it
				// without counting a leave.
				t.dropPeer(m.UID, false)
			}
			platform := t.claimPlatform(now)
			id := t.sameAs(m.Name, platform)
			if id == "" {
				id = t.join(m.Name, platform, now)
			} else if i := t.index(id); platform != logparse.PlatformUnknown && t.s.Players[i].Platform == logparse.PlatformUnknown {
				// A known platform fills in an unknown one, never replaces
				// a known one.
				t.s.Players[i].Platform = platform
			}
			// Not now (UTC strips the monotonic reading): SetPeers compares
			// it with the time a plugin read began.
			t.addPeer(m.UID, id, t.now())
		case logparse.KindAbandoned:
			// One line per object the peer owned; the first one is the
			// peer's leave. Its character is one of them, so every peer that
			// spawned gets one.
			t.dropPeer(m.UID, true)
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
		t.pending = nil // every connection closed with the game
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

// dropPeer forgets one peer id and takes its player off the list once no
// other peer is online under it. lost means the peer disconnected: it then also
// comes off the reported count, which the lagging connection-lost line
// leaves one too high. The count stays at least the number of names listed.
// Not the number of peer ids: a reconnect's old id lingers until its
// abandoned lines come. Caller holds mu.
func (t *Tracker) dropPeer(uid string, lost bool) {
	id, ok := t.uids[uid]
	if !ok {
		return
	}
	delete(t.uids, uid)
	delete(t.seen, uid)
	delete(t.confirmed, uid)
	peers := t.peers[id]
	delete(peers, uid)
	if len(peers) == 0 {
		delete(t.peers, id)
		t.leave(id)
	}
	if !lost {
		return
	}
	if n := max(t.s.PlayersReported-1, len(t.s.Players)); n < t.s.PlayersReported {
		t.s.PlayersReported = n
		t.hub.Publish("player_count", map[string]any{"count": n})
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

// sameAs picks the listed player a new peer id under name belongs to, or ""
// for a new player. The log cannot tell a second player with the same name
// from a reconnect whose old peer is not cleaned up yet: the player count
// includes clients still loading and the peer ids include stale ones. So a
// listed name is always the same player, a missed split rather than a
// phantom one, and the admin plugin's player list splits it when both peers
// are alive (SetPeers). Among several players with the name (split by the
// plugin), the one on the claimed platform wins, else the first. Caller
// holds mu.
func (t *Tracker) sameAs(name, platform string) string {
	first, match := "", ""
	for _, p := range t.s.Players {
		if p.Name != name {
			continue
		}
		if len(t.peers[p.ID]) == 0 {
			// Listed from a death line, without a peer yet.
			return p.ID
		}
		if first == "" {
			first = p.ID
		}
		if match == "" && platform != logparse.PlatformUnknown && p.Platform == platform {
			match = p.ID
		}
	}
	if match != "" {
		return match
	}
	return first
}

// addPeer puts a peer id on a listed player. Caller holds mu.
func (t *Tracker) addPeer(uid, id string, at time.Time) {
	if t.peers[id] == nil {
		t.peers[id] = map[string]struct{}{}
	}
	t.uids[uid] = id
	t.peers[id][uid] = struct{}{}
	if _, ok := t.seen[uid]; !ok {
		t.seen[uid] = at
	}
}

// index finds a listed player by ID, -1 when not listed. Caller holds mu.
func (t *Tracker) index(id string) int {
	for i, p := range t.s.Players {
		if p.ID == id {
			return i
		}
	}
	return -1
}

// byName finds the first listed player with a name, -1 when none. Caller
// holds mu.
func (t *Tracker) byName(name string) int {
	for i, p := range t.s.Players {
		if p.Name == name {
			return i
		}
	}
	return -1
}

// join lists a new player and returns its ID: the name, or the name with
// the lowest free "#n" when someone online already uses it. Caller holds mu.
func (t *Tracker) join(name, platform string, now time.Time) string {
	id := name
	for n := 2; t.index(id) >= 0; n++ {
		id = name + "#" + strconv.Itoa(n)
	}
	t.s.Players = append(t.s.Players, Player{ID: id, Name: name, Since: now, Platform: platform})
	t.hub.Publish("player_join", map[string]any{"name": name, "id": id, "platform": platform})
	return id
}

// leave takes one player off the list. Caller holds mu.
func (t *Tracker) leave(id string) {
	if i := t.index(id); i >= 0 {
		p := t.s.Players[i]
		t.s.Players = append(t.s.Players[:i:i], t.s.Players[i+1:]...)
		t.hub.Publish("player_leave", map[string]any{"name": p.Name, "id": id})
	}
}

// Peer is one connection the admin plugin lists: its peer id, its
// character's name, its platform (unknown when the game reports none) and
// its account: the platform user id, "" when the game reports none. Two
// peers of one account are one player reconnecting. The account never
// leaves the tracker.
type Peer struct {
	UID, Name, Platform, Account string
}

// PeersWanted tells whether a plugin player list would settle something: a
// peer id no list has confirmed yet, or a player holding several peer ids
// (a reconnect not cleaned up, or two players the log merged).
func (t *Tracker) PeersWanted() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for uid := range t.uids {
		if _, ok := t.confirmed[uid]; !ok {
			return true
		}
	}
	for _, peers := range t.peers {
		if len(peers) > 1 {
			return true
		}
	}
	return false
}

// SetPeers takes the admin plugin's player list, read at readAt, as the
// authority on which peer id is whose and on what platform; the log only
// guesses both. Only peer ids the log reported before readAt are judged: a
// newer one may have connected after the read. Per name it
//   - expires peer ids the list no longer has (a reconnect's old peer),
//     without a leave while the player has another live peer,
//   - hands a player's live peers of another account to a same-name player
//     left with only expired ones (a reconnect the log attached to the
//     wrong one),
//   - lists the live peers of any other account left over as a new player
//     (two players the log took for a reconnect), and
//   - puts the platform of each player's newest live peer on it,
//     publishing `player_platform` when it changes; unknown never replaces
//     a platform.
//
// Peers of one account, or without one, are never split apart. It returns
// the id of every listed peer the tracker knows, by peer id.
func (t *Tracker) SetPeers(readAt time.Time, list []Peer) map[string]string {
	t.mu.Lock()
	defer t.mu.Unlock()
	live := make(map[string]Peer, len(list))
	for _, p := range list {
		live[p.UID] = p
	}
	judged := func(uid string) bool { return t.seen[uid].Before(readAt) }
	var stale []string
	for uid := range t.uids {
		if !judged(uid) {
			continue
		}
		if _, ok := live[uid]; ok {
			t.confirmed[uid] = struct{}{}
		} else {
			stale = append(stale, uid)
		}
	}
	slices.Sort(stale)

	names := []string{}
	for _, p := range t.s.Players {
		if !slices.Contains(names, p.Name) {
			names = append(names, p.Name)
		}
	}
	for _, name := range names {
		// spare: the live peers of each account a player does not keep.
		var spare [][]string
		var orphans []string
		for _, p := range t.s.Players {
			if p.Name != name || len(t.peers[p.ID]) == 0 {
				continue
			}
			var alive []string
			orphan := true
			for uid := range t.peers[p.ID] {
				if lp, ok := live[uid]; ok && judged(uid) && lp.Name == name {
					alive = append(alive, uid)
				} else if !judged(uid) {
					orphan = false // too new to tell
				}
			}
			if len(alive) == 0 {
				if orphan {
					orphans = append(orphans, p.ID)
				}
				continue
			}
			t.sortPeers(alive)
			// Accounts in order of their oldest peer; peers without one stay
			// with the player.
			var accounts []string
			byAccount := map[string][]string{}
			for _, uid := range alive {
				acct := live[uid].Account
				if acct == "" {
					continue
				}
				if _, ok := byAccount[acct]; !ok {
					accounts = append(accounts, acct)
				}
				byAccount[acct] = append(byAccount[acct], uid)
			}
			if len(accounts) <= 1 {
				continue
			}
			keep := accounts[0]
			for _, acct := range accounts {
				if t.newestPlatform(byAccount[acct], live) == p.Platform {
					keep = acct
					break
				}
			}
			for _, acct := range accounts {
				if acct != keep {
					spare = append(spare, byAccount[acct])
				}
			}
		}
		for _, id := range orphans {
			if len(spare) == 0 {
				break
			}
			i := t.index(id)
			pick := 0
			for j, group := range spare {
				if t.newestPlatform(group, live) == t.s.Players[i].Platform {
					pick = j
					break
				}
			}
			for _, uid := range spare[pick] {
				t.movePeer(uid, id)
			}
			spare = slices.Delete(spare, pick, pick+1)
		}
		for _, group := range spare {
			platform := t.newestPlatform(group, live)
			if platform == "" {
				platform = logparse.PlatformUnknown
			}
			// Listed from now, as its player_join says.
			id := t.join(name, platform, t.now().UTC())
			for _, uid := range group {
				t.movePeer(uid, id)
			}
		}
	}
	for _, uid := range stale {
		t.dropPeer(uid, true)
	}

	for i, p := range t.s.Players {
		var alive []string
		for uid := range t.peers[p.ID] {
			if _, ok := live[uid]; ok && judged(uid) {
				alive = append(alive, uid)
			}
		}
		platform := t.newestPlatform(alive, live)
		if platform == "" || platform == p.Platform {
			continue
		}
		t.s.Players[i].Platform = platform
		t.hub.Publish("player_platform", map[string]any{"name": p.Name, "id": p.ID, "platform": platform})
	}

	ids := map[string]string{}
	for _, p := range list {
		if id, ok := t.uids[p.UID]; ok {
			ids[p.UID] = id
		}
	}
	return ids
}

// newestPlatform is the known platform of the newest of these live peers,
// "" when none has one. Caller holds mu.
func (t *Tracker) newestPlatform(uids []string, live map[string]Peer) string {
	sorted := slices.Clone(uids)
	t.sortPeers(sorted)
	for i := len(sorted) - 1; i >= 0; i-- {
		if p := live[sorted[i]].Platform; p != "" && p != logparse.PlatformUnknown {
			return p
		}
	}
	return ""
}

// movePeer puts a peer id on another listed player, keeping when it was
// seen. Caller holds mu.
func (t *Tracker) movePeer(uid, id string) {
	if old, ok := t.uids[uid]; ok {
		delete(t.peers[old], uid)
	}
	t.addPeer(uid, id, t.seen[uid])
}

// sortPeers orders peer ids oldest first. Caller holds mu.
func (t *Tracker) sortPeers(uids []string) {
	slices.SortFunc(uids, func(a, b string) int {
		if c := t.seen[a].Compare(t.seen[b]); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	})
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
			t.hub.Publish("player_leave", map[string]any{"name": p.Name, "id": p.ID})
		}
		t.s.Players = []Player{}
	}
	if n == 0 {
		// Pending platforms stay: they expire on their own, and a client
		// still loading can be outside a lagging count.
		clear(t.uids)
		clear(t.peers)
		clear(t.seen)
		clear(t.confirmed)
	}
}
