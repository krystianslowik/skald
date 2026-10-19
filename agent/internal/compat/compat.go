// Package compat checks Skald against the game build it runs next to. The
// game updates itself on every restart, and a new build can change a save
// format or a log line without notice: build l-1.0.20 changed the inventory
// version and every chest it saved went unreadable on the map. The checker
// runs when the log reports a game build it has not checked yet (also once
// after the agent starts), waits for the world to load and the map to be
// built from the newest save, and grades what Skald reads from that build:
// the version line, the save, the terrain, the bridge and the log lines it
// relies on. The result is kept on disk with the build before it.
package compat

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/terrain"
	"github.com/krystianslowik/skald/agent/internal/worldmap"
)

// Check statuses. Pending (waiting for something that comes on its own, such
// as the first save by a new build) and skipped (not configured) do not count
// toward the overall status.
const (
	StatusOK      = "ok"
	StatusWarn    = "warn"
	StatusFail    = "fail"
	StatusPending = "pending"
	StatusSkipped = "skipped"
)

// What started a check.
const (
	// TriggerStart: the first build the agent saw since it started, the same
	// one as last time.
	TriggerStart = "start"
	// TriggerUpdate: a build other than the one checked last.
	TriggerUpdate = "update"
	// TriggerSave: the first save by an updated build, which the check
	// after the update could not read yet.
	TriggerSave = "save"
	// TriggerManual: an admin asked from the panel.
	TriggerManual = "manual"
)

// Check names, in the order they are shown.
const (
	CheckVersion = "version"
	CheckSave    = "save"
	CheckTerrain = "terrain"
	CheckBridge  = "bridge"
	CheckLogs    = "logs"
)

// CheckNames lists every check in display order.
var CheckNames = []string{CheckVersion, CheckSave, CheckTerrain, CheckBridge, CheckLogs}

// Check is one graded part. Reason is a short machine code; Detail holds the
// numbers behind it. Neither carries paths, names or ids.
type Check struct {
	Name   string         `json:"name"`
	Status string         `json:"status"`
	Reason string         `json:"reason,omitempty"`
	Detail map[string]any `json:"detail,omitempty"`
}

// Result is one completed check.
type Result struct {
	Build          string `json:"build"`
	NetworkVersion int    `json:"networkVersion"`
	// PreviousBuild is the build checked before this one; empty on the very
	// first check. It stays across re-checks of the same build.
	PreviousBuild          string `json:"previousBuild,omitempty"`
	PreviousNetworkVersion int    `json:"previousNetworkVersion,omitempty"`
	// Updated: this build replaced PreviousBuild.
	Updated   bool      `json:"updated"`
	Trigger   string    `json:"trigger"`
	StartedAt time.Time `json:"startedAt"`
	CheckedAt time.Time `json:"checkedAt"`
	// Status is the worst of the checks (ok, warn or fail).
	Status string `json:"status"`
	// AwaitingSave: the newest save is from before the update; the save
	// check runs again after the first save by this build.
	AwaitingSave bool `json:"awaitingSave"`
	// Generation is the save generation the map was built from.
	Generation int     `json:"generation"`
	Checks     []Check `json:"checks"`
}

// Check returns the named check, or nil.
func (r *Result) Check(name string) *Check {
	if r == nil {
		return nil
	}
	for i := range r.Checks {
		if r.Checks[i].Name == name {
			return &r.Checks[i]
		}
	}
	return nil
}

// View is GET /compat and the compat part of /state.
type View struct {
	// Running: a check is waiting for the world or the map right now.
	Running bool `json:"running"`
	// Result is the last completed check; null before the first.
	Result *Result `json:"result"`
}

// MapSource is the world map builder (worldmap.Builder).
type MapSource interface {
	Enabled() bool
	Refresh() (bool, error)
	Health() worldmap.Health
}

// BridgeSource is the admin plugin (bridge.Client).
type BridgeSource interface {
	Status(ctx context.Context) bridge.Status
}

type Options struct {
	// State is the tracker's snapshot: the version, the log marks and saves.
	State func() state.Snapshot
	// Map is the world map; nil or disabled skips the save check.
	Map MapSource
	// Terrain is the terrain summary; nil (or not enabled) skips that check.
	Terrain func() *terrain.Info
	// Bridge is nil without BRIDGE_TOKEN: the bridge check is skipped.
	Bridge BridgeSource
	// Crossplay says whether the server runs with -crossplay, so a join
	// code is expected in the log.
	Crossplay func() bool
	// Path is where the last result is kept (compat.json in SETTINGS_DIR);
	// empty or unwritable keeps it in memory.
	Path string
	// Publish sends the `compat` event (hub.Publish).
	Publish func(typ string, data map[string]any)
	Logger  *slog.Logger
	Now     func() time.Time
	// WaitFor bounds the wait for the world and the map; 5 min when zero.
	WaitFor time.Duration
	// Poll is how often the wait looks again; 5 s when zero.
	Poll time.Duration
	// LogWindow is how long after the version line the world must load and
	// the join code show up; 5 min when zero.
	LogWindow time.Duration
}

// ErrRunning is returned by Start while a check runs.
var ErrRunning = errors.New("compat: a check is running")

type Checker struct {
	opt Options

	mu      sync.Mutex
	result  *Result
	running bool
	// checked is the build the loop last started a check for; "" until the
	// first, so the first build seen after a start is always checked.
	checked string
	// saveSeen is the save the loop last re-checked after, so one save
	// starts at most one check.
	saveSeen time.Time
	// base is Run's context, for checks started from the panel.
	base context.Context
}

func New(opt Options) *Checker {
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.WaitFor == 0 {
		opt.WaitFor = 5 * time.Minute
	}
	if opt.Poll == 0 {
		opt.Poll = 5 * time.Second
	}
	if opt.LogWindow == 0 {
		opt.LogWindow = 5 * time.Minute
	}
	if opt.Publish == nil {
		opt.Publish = func(string, map[string]any) {}
	}
	if opt.Crossplay == nil {
		opt.Crossplay = func() bool { return false }
	}
	c := &Checker{opt: opt}
	c.result = c.load()
	return c
}

// View is the last result and whether a check runs.
func (c *Checker) View() View {
	if c == nil {
		return View{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return View{Running: c.running, Result: c.result}
}

// Run looks for a new build every `every` until ctx ends. A check runs in
// this goroutine, so a slow one delays the next look, never overlaps it.
func (c *Checker) Run(ctx context.Context, every time.Duration) {
	c.mu.Lock()
	c.base = ctx
	c.mu.Unlock()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		c.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Tick starts a check when the log reports a build not checked since the
// agent started, or when an updated build saved for the first time. It
// returns once that check is done.
func (c *Checker) Tick(ctx context.Context) {
	snap := c.opt.State()
	if snap.Version == "" {
		// The agent started after the game and has not seen its version
		// line: nothing to check against. The kept result stays.
		return
	}
	c.mu.Lock()
	if c.running {
		c.mu.Unlock()
		return
	}
	trigger := ""
	switch r := c.result; {
	case snap.Version != c.checked:
		trigger = TriggerStart
		if r != nil && r.Build != "" && r.Build != snap.Version {
			trigger = TriggerUpdate
		}
		c.checked = snap.Version
	case r != nil && r.AwaitingSave && r.Build == snap.Version && savedByThisBuild(snap) && !snap.LastSaveAt.Equal(c.saveSeen):
		trigger = TriggerSave
		c.saveSeen = *snap.LastSaveAt
	}
	if trigger == "" {
		c.mu.Unlock()
		return
	}
	c.running = true
	prev := c.result
	c.mu.Unlock()
	c.publish(true, prev)
	c.finish(c.check(ctx, trigger, prev))
}

// Start runs a check now, in the background, for an admin.
func (c *Checker) Start() error {
	c.mu.Lock()
	if c.running {
		c.mu.Unlock()
		return ErrRunning
	}
	c.running = true
	prev := c.result
	ctx := c.base
	c.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	c.publish(true, prev)
	go func() { c.finish(c.check(ctx, TriggerManual, prev)) }()
	return nil
}

func (c *Checker) finish(r *Result) {
	c.mu.Lock()
	if r != nil {
		c.result = r
	}
	c.running = false
	cur := c.result
	c.mu.Unlock()
	if r != nil {
		c.save(r)
		c.opt.Logger.Info("compatibility check done", "build", r.Build, "previous", r.PreviousBuild, "trigger", r.Trigger, "status", r.Status, "failing", failing(r))
	}
	c.publish(false, cur)
}

func (c *Checker) publish(running bool, r *Result) {
	c.opt.Publish("compat", map[string]any{"running": running, "result": r})
}

// failing lists the checks that warn or fail, for the log line.
func failing(r *Result) []string {
	var out []string
	for _, ch := range r.Checks {
		if ch.Status == StatusWarn || ch.Status == StatusFail {
			out = append(out, ch.Name+":"+ch.Reason)
		}
	}
	return out
}

// savedByThisBuild: the game logged a save after its version line, so the
// newest save on disk was written by the running build.
func savedByThisBuild(s state.Snapshot) bool {
	return s.LastSaveAt != nil && (s.VersionAt == nil || s.LastSaveAt.After(*s.VersionAt))
}

// after: t is set and not before the version line (or there is none).
func after(t, version *time.Time) bool {
	return t != nil && (version == nil || !t.Before(*version))
}

// check waits (bounded) for the world and the map, then grades every part.
// It returns nil only when ctx ended.
func (c *Checker) check(ctx context.Context, trigger string, prev *Result) *Result {
	start := c.opt.Now().UTC()
	snap := c.opt.State()
	r := &Result{Build: snap.Version, NetworkVersion: snap.NetworkVersion, Trigger: trigger, StartedAt: start}
	seen := snap.Version != ""
	if !seen && prev != nil {
		// An admin's check before the agent saw the version line (it started
		// after the game): the build is the one checked last.
		r.Build, r.NetworkVersion = prev.Build, prev.NetworkVersion
	}
	needSave := trigger == TriggerUpdate
	minGen := 0
	switch {
	case prev == nil || prev.Build == "":
	case prev.Build != r.Build:
		r.PreviousBuild, r.PreviousNetworkVersion, r.Updated = prev.Build, prev.NetworkVersion, true
		// The first check of a new build is the update's, however it started
		// (an admin may have pressed Check again before the loop saw it).
		r.Trigger, needSave = TriggerUpdate, true
	default:
		// The same build again: keep what it replaced.
		r.PreviousBuild, r.PreviousNetworkVersion, r.Updated = prev.PreviousBuild, prev.PreviousNetworkVersion, prev.Updated
		if prev.AwaitingSave {
			needSave = true
		}
		if trigger == TriggerSave {
			minGen = prev.Generation
		}
	}
	crossplay := c.opt.Crossplay()
	mapOn := c.opt.Map != nil && c.opt.Map.Enabled()

	// Wait for the world to load (and the join code with crossplay), and for
	// the map to be built from the newest finished save.
	deadline := start.Add(c.opt.WaitFor)
	var h worldmap.Health
	waited := false
	for {
		snap = c.opt.State()
		loaded := after(snap.WorldLoadedAt, snap.VersionAt) || snap.VersionAt == nil
		joined := !crossplay || after(snap.JoinCodeSeenAt, snap.VersionAt) || snap.VersionAt == nil
		mapReady := true
		if mapOn {
			if _, err := c.opt.Map.Refresh(); err != nil {
				c.opt.Logger.Debug("compatibility check: map not rebuilt", "reason", err.Error())
			}
			h = c.opt.Map.Health()
			// A failed build has nothing more to wait for.
			mapReady = h.Current() && h.Generation > minGen || h.Failure != ""
		}
		// The plugin reports the world a moment after the log does.
		bridgeReady := c.opt.Bridge == nil || !loaded || c.bridgeStatus(ctx).Reason != "loading"
		if loaded && joined && mapReady && bridgeReady {
			break
		}
		if !c.opt.Now().Before(deadline) {
			waited = true
			break
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(c.opt.Poll):
		}
	}
	r.Generation = h.Generation

	r.Checks = []Check{
		versionCheck(r, seen),
		saveCheck(mapOn, h, needSave && !savedByThisBuild(snap), waited && !(h.Current() && h.Generation > minGen)),
		terrainCheck(c.opt.Terrain),
		c.bridgeCheck(ctx, snap.Version),
		logsCheck(snap, crossplay, c.opt.LogWindow, c.opt.Now()),
	}
	r.Status = Overall(r.Checks)
	if s := r.Check(CheckSave); s != nil && s.Reason == "save_before_update" {
		r.AwaitingSave = true
	}
	r.CheckedAt = c.opt.Now().UTC()
	return r
}

// Overall is the worst status among the checks that count.
func Overall(checks []Check) string {
	worst := StatusOK
	for _, ch := range checks {
		switch ch.Status {
		case StatusFail:
			return StatusFail
		case StatusWarn:
			worst = StatusWarn
		}
	}
	return worst
}

// versionCheck: seen is false when the agent has not seen the version line
// since it started (only an admin's check runs then).
func versionCheck(r *Result, seen bool) Check {
	ch := Check{Name: CheckVersion, Status: StatusOK, Detail: map[string]any{"build": r.Build, "networkVersion": r.NetworkVersion}}
	switch {
	case !seen:
		ch.Status, ch.Reason = StatusWarn, "not_seen"
	case r.PreviousBuild == "":
		ch.Reason = "first"
	case r.Updated:
		ch.Reason = "updated"
		ch.Detail["previousBuild"] = r.PreviousBuild
		ch.Detail["previousNetworkVersion"] = r.PreviousNetworkVersion
		// Players need the same network version: their game has to update too.
		ch.Detail["networkChanged"] = r.PreviousNetworkVersion != 0 && r.PreviousNetworkVersion != r.NetworkVersion
	default:
		ch.Reason = "unchanged"
	}
	return ch
}

// saveCheck grades how the save read. pendingSave: the newest save is from
// before the update. behind: the wait ran out before the map was built from
// the save it waited for.
func saveCheck(on bool, h worldmap.Health, pendingSave, behind bool) Check {
	ch := Check{Name: CheckSave, Status: StatusOK}
	if !on {
		ch.Status, ch.Reason = StatusSkipped, "no_world"
		return ch
	}
	ch.Detail = map[string]any{
		"generation":           h.Generation,
		"chunks":               h.Chunks,
		"chunksUnreadable":     h.ChunksUnreadable,
		"containersUnreadable": h.ContainersUnreadable,
		"locationsRead":        !h.LocationsUnreadable,
		"metaRead":             !h.MetaUnreadable,
	}
	if h.ContainerReason != "" {
		// The code (and its value) is what the panel and the notifications
		// translate; the text stays for a code they do not know yet.
		ch.Detail["containerReason"] = h.ContainerReason
		ch.Detail["containerReasonCode"] = h.ContainerWhy.Code
		ch.Detail["containerReasonValue"] = h.ContainerWhy.Value
	}
	switch {
	case !h.Built() && h.Failure == worldmap.FailNoSave:
		// A new world the game has not saved yet.
		ch.Status, ch.Reason = StatusPending, "no_save"
	case !h.Built():
		ch.Status, ch.Reason = StatusFail, "not_built"
	case h.Failure == worldmap.FailIndex:
		ch.Status, ch.Reason = StatusFail, "index_unreadable"
	case h.ContainersUnreadable > 0:
		ch.Status, ch.Reason = StatusFail, "containers_unreadable"
	case h.ChunksUnreadable > 0:
		ch.Status, ch.Reason = StatusFail, "chunks_unreadable"
	case h.LocationsUnreadable:
		ch.Status, ch.Reason = StatusWarn, "locations_unreadable"
	case h.MetaUnreadable:
		ch.Status, ch.Reason = StatusWarn, "meta_unreadable"
	case behind:
		ch.Status, ch.Reason = StatusWarn, "map_behind"
	case pendingSave:
		ch.Status, ch.Reason = StatusPending, "save_before_update"
	}
	return ch
}

func terrainCheck(info func() *terrain.Info) Check {
	ch := Check{Name: CheckTerrain, Status: StatusOK}
	var i *terrain.Info
	if info != nil {
		i = info()
	}
	if i == nil || !i.Enabled {
		ch.Status, ch.Reason = StatusSkipped, "not_configured"
		return ch
	}
	if i.Build != "" {
		ch.Detail = map[string]any{"build": i.Build}
	}
	switch {
	case !i.Available && i.Reason == "unreadable":
		ch.Status, ch.Reason = StatusFail, "unreadable"
	case !i.Available:
		ch.Status, ch.Reason = StatusWarn, orDefault(i.Reason, "missing")
	case i.Stale && i.Reason == "gameBuild":
		// The terrain job renders again for the new build on its own.
		ch.Status, ch.Reason = StatusPending, "gameBuild"
	case i.Stale:
		ch.Status, ch.Reason = StatusWarn, i.Reason
	}
	return ch
}

// buildPrefix is the branch letter Valheim puts before its version ("l-").
var buildPrefix = regexp.MustCompile(`^[a-z]-`)

func sameBuild(a, b string) bool {
	return buildPrefix.ReplaceAllString(a, "") == buildPrefix.ReplaceAllString(b, "")
}

func (c *Checker) bridgeStatus(ctx context.Context) bridge.Status {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.opt.Bridge.Status(ctx)
}

func (c *Checker) bridgeCheck(ctx context.Context, logBuild string) Check {
	ch := Check{Name: CheckBridge, Status: StatusOK}
	if c.opt.Bridge == nil {
		ch.Status, ch.Reason = StatusSkipped, "not_configured"
		return ch
	}
	st := c.bridgeStatus(ctx)
	ch.Detail = map[string]any{"tested": st.Tested, "acknowledged": st.Acknowledged}
	if st.Plugin != "" {
		ch.Detail["plugin"] = st.Plugin
	}
	if st.GameBuild != "" {
		ch.Detail["gameBuild"] = st.GameBuild
	}
	switch {
	case st.Reason == "loading":
		ch.Status, ch.Reason = StatusWarn, "loading"
	case !st.Available:
		// unreachable, disabled (the plugin turned itself off) or token.
		ch.Status, ch.Reason = StatusFail, orDefault(st.Reason, "unreachable")
	case logBuild != "" && st.GameBuild != "" && !sameBuild(st.GameBuild, logBuild):
		ch.Status, ch.Reason = StatusWarn, "build_mismatch"
	case !st.Tested && !st.Acknowledged:
		ch.Status, ch.Reason = StatusWarn, "untested"
	case !st.Tested:
		ch.Reason = "acknowledged"
	}
	return ch
}

// logsCheck: the lines Skald reads at a game start came. Lines that have not
// come yet are pending within the window after the version line, missing after.
func logsCheck(s state.Snapshot, crossplay bool, window time.Duration, now time.Time) Check {
	ch := Check{Name: CheckLogs, Status: StatusOK, Detail: map[string]any{"crossplay": crossplay}}
	if s.VersionAt == nil {
		ch.Status, ch.Reason = StatusSkipped, "not_seen"
		return ch
	}
	within := func(t *time.Time) bool { return after(t, s.VersionAt) }
	loaded := within(s.WorldLoadedAt)
	ch.Detail["worldLoaded"] = loaded
	if loaded {
		ch.Detail["worldLoadedSeconds"] = int(s.WorldLoadedAt.Sub(*s.VersionAt).Seconds())
	}
	joined := false
	if crossplay {
		joined = within(s.JoinCodeSeenAt)
		ch.Detail["joinCode"] = joined
	}
	// Still inside the window: the line may yet come.
	early := now.Sub(*s.VersionAt) < window
	switch {
	case !loaded && early:
		ch.Status, ch.Reason = StatusPending, "world_loading"
	case !loaded:
		ch.Status, ch.Reason = StatusWarn, "world_loaded_missing"
	case crossplay && !joined && early:
		ch.Status, ch.Reason = StatusPending, "join_code_waiting"
	case crossplay && !joined:
		ch.Status, ch.Reason = StatusWarn, "join_code_missing"
	}
	return ch
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// ---- persistence ----------------------------------------------------------

type stored struct {
	Result *Result `json:"result"`
}

func (c *Checker) load() *Result {
	if c.opt.Path == "" {
		return nil
	}
	b, err := os.ReadFile(c.opt.Path)
	if err != nil {
		return nil
	}
	var s stored
	if json.Unmarshal(b, &s) != nil {
		c.opt.Logger.Info("compatibility check: kept result unreadable, starting afresh", "path", c.opt.Path)
		return nil
	}
	return s.Result
}

func (c *Checker) save(r *Result) {
	if c.opt.Path == "" {
		return
	}
	b, _ := json.Marshal(stored{Result: r})
	tmp := filepath.Join(filepath.Dir(c.opt.Path), ".compat.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err == nil {
		if err = os.Rename(tmp, c.opt.Path); err == nil {
			return
		}
	}
	c.opt.Logger.Info("compatibility check result kept in memory only", "path", c.opt.Path)
}
