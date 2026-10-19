package compat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/terrain"
	"github.com/krystianslowik/skald/agent/internal/worldmap"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// world is the game as the checker sees it: the tracker's snapshot and the map.
type world struct {
	mu   sync.Mutex
	snap state.Snapshot
	h    worldmap.Health
}

func (w *world) State() state.Snapshot {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.snap
}

func (w *world) Enabled() bool          { return true }
func (w *world) Refresh() (bool, error) { return false, nil }
func (w *world) Health() worldmap.Health {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.h
}

func (w *world) set(f func(s *state.Snapshot, h *worldmap.Health)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	f(&w.snap, &w.h)
}

func at(t time.Time) *time.Time { return &t }

// started is a game that logged its version and loaded its world, with the
// map built from generation gen.
func started(build string, net int, gen int) *world {
	now := time.Now().UTC()
	return &world{
		snap: state.Snapshot{Version: build, NetworkVersion: net, VersionAt: at(now.Add(-time.Minute)), WorldLoadedAt: at(now.Add(-30 * time.Second))},
		h:    worldmap.Health{Generation: gen, Latest: gen, HasLatest: true, BuiltAt: now, Chunks: 10},
	}
}

// recorder keeps the published events.
type recorder struct {
	mu     sync.Mutex
	events []map[string]any
}

func (r *recorder) all() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]any{}, r.events...)
}

func newChecker(t *testing.T, w *world, path string) (*Checker, *recorder) {
	t.Helper()
	rec := &recorder{}
	c := New(Options{
		State: w.State,
		Map:   w,
		Path:  path,
		Publish: func(typ string, data map[string]any) {
			if typ != "compat" {
				t.Errorf("published %q", typ)
			}
			rec.mu.Lock()
			rec.events = append(rec.events, data)
			rec.mu.Unlock()
		},
		Logger:    quiet,
		WaitFor:   50 * time.Millisecond,
		Poll:      time.Millisecond,
		LogWindow: 5 * time.Minute,
	})
	return c, rec
}

func TestTriggers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "compat.json")
	w := &world{}
	c, events := newChecker(t, w, path)
	ctx := context.Background()

	// No version line yet: nothing runs.
	c.Tick(ctx)
	if v := c.View(); v.Result != nil || len(events.all()) != 0 {
		t.Fatalf("checked without a version: %+v", v)
	}

	// The first build after a start: checked once, nothing before it.
	*w = *started("l-1.0.17", 40, 3)
	c.Tick(ctx)
	r := c.View().Result
	if r == nil || r.Trigger != TriggerStart || r.Build != "l-1.0.17" || r.PreviousBuild != "" || r.Updated || r.Status != StatusOK || r.AwaitingSave {
		t.Fatalf("first check = %+v", r)
	}
	if ch := r.Check(CheckVersion); ch.Reason != "first" {
		t.Errorf("version = %+v", ch)
	}
	if ev := events.all(); len(ev) != 2 || ev[0]["running"] != true || ev[1]["running"] != false || ev[1]["result"] != r {
		t.Errorf("events = %+v", ev)
	}

	// The same build again (a later line, a game restart without an update): no new check.
	c.Tick(ctx)
	if c.View().Result != r || len(events.all()) != 2 {
		t.Fatal("same build checked again")
	}

	// A new build: an update, whose save is still the old build's.
	w.set(func(s *state.Snapshot, _ *worldmap.Health) {
		now := time.Now().UTC()
		s.Version, s.NetworkVersion = "l-1.0.20", 41
		s.LastSaveAt = at(now.Add(-2 * time.Minute)) // the old game's save at shutdown
		s.VersionAt, s.WorldLoadedAt = at(now.Add(-time.Minute)), at(now.Add(-30*time.Second))
	})
	c.Tick(ctx)
	up := c.View().Result
	if up.Trigger != TriggerUpdate || up.PreviousBuild != "l-1.0.17" || up.PreviousNetworkVersion != 40 || !up.Updated || !up.AwaitingSave || up.Status != StatusOK {
		t.Fatalf("update = %+v", up)
	}
	if ch := up.Check(CheckVersion); ch.Reason != "updated" || ch.Detail["networkChanged"] != true {
		t.Errorf("version = %+v", ch)
	}
	if ch := up.Check(CheckSave); ch.Status != StatusPending || ch.Reason != "save_before_update" {
		t.Errorf("save = %+v", ch)
	}

	// Nothing saved yet: no re-check.
	c.Tick(ctx)
	if c.View().Result != up {
		t.Fatal("re-checked before the first save")
	}

	// The first save by the new build, with chests it wrote in a new format.
	w.set(func(s *state.Snapshot, h *worldmap.Health) {
		s.LastSaveAt = at(time.Now().UTC())
		h.Generation, h.Latest = 4, 4
		h.ContainersUnreadable, h.ContainerReason = 41, "unreadable inventory: version 111"
		h.ContainerWhy = worldmap.InvReason{Code: worldmap.ReasonVersion, Value: 111}
	})
	c.Tick(ctx)
	sv := c.View().Result
	if sv.Trigger != TriggerSave || sv.PreviousBuild != "l-1.0.17" || !sv.Updated || sv.AwaitingSave || sv.Status != StatusFail || sv.Generation != 4 {
		t.Fatalf("after the first save = %+v", sv)
	}
	if ch := sv.Check(CheckSave); ch.Reason != "containers_unreadable" || ch.Detail["containersUnreadable"] != 41 || ch.Detail["containerReason"] != "unreadable inventory: version 111" ||
		ch.Detail["containerReasonCode"] != "inventory_version" || ch.Detail["containerReasonValue"] != int64(111) {
		t.Errorf("save = %+v", ch)
	}
	c.Tick(ctx)
	if c.View().Result != sv {
		t.Fatal("checked twice after one save")
	}

	// The agent restarts on the same build: checked once more, still an update from 1.0.17.
	c2, _ := newChecker(t, w, path)
	if r := c2.View().Result; r == nil || r.Build != "l-1.0.20" || r.Status != StatusFail {
		t.Fatalf("kept result = %+v", r)
	}
	c2.Tick(ctx)
	re := c2.View().Result
	if re.Trigger != TriggerStart || re.PreviousBuild != "l-1.0.17" || !re.Updated || re.AwaitingSave {
		t.Errorf("restart = %+v", re)
	}

	// The agent restarts and the log reports yet another build: an update from the kept one.
	w.set(func(s *state.Snapshot, _ *worldmap.Health) { s.Version = "l-1.0.21" })
	c3, _ := newChecker(t, w, path)
	c3.Tick(ctx)
	if r := c3.View().Result; r.Trigger != TriggerUpdate || r.PreviousBuild != "l-1.0.20" || r.NetworkVersion != 41 {
		t.Errorf("update across a restart = %+v", r)
	}
}

func TestUpdateWaitsForTheNewSaveGeneration(t *testing.T) {
	w := started("l-1.0.20", 41, 7)
	w.snap.LastSaveAt = at(time.Now())
	c, _ := newChecker(t, w, "")
	prev := &Result{Build: "l-1.0.20", PreviousBuild: "l-1.0.17", Updated: true, AwaitingSave: true, Generation: 7}
	// The save's log line came, but the map is still from generation 7: the
	// wait runs out and says so instead of grading the old save.
	r := c.check(context.Background(), TriggerSave, prev)
	if ch := r.Check(CheckSave); ch.Status != StatusWarn || ch.Reason != "map_behind" || r.Generation != 7 {
		t.Errorf("stale generation = %+v gen %d", ch, r.Generation)
	}
	w.set(func(_ *state.Snapshot, h *worldmap.Health) { h.Generation, h.Latest = 8, 8 })
	if ch := c.check(context.Background(), TriggerSave, prev).Check(CheckSave); ch.Status != StatusOK {
		t.Errorf("new generation = %+v", ch)
	}
	w.set(func(_ *state.Snapshot, h *worldmap.Health) { h.Generation = 7 })
	w.set(func(_ *state.Snapshot, h *worldmap.Health) { h.Latest = 8 })
	r = c.check(context.Background(), TriggerSave, prev)
	if ch := r.Check(CheckSave); ch.Status != StatusWarn || ch.Reason != "map_behind" {
		t.Errorf("map behind = %+v", ch)
	}
}

func TestBoundedWait(t *testing.T) {
	// The world never loads (a log line that changed): the check ends, it does not hang.
	w := started("l-1.0.20", 41, 3)
	w.snap.WorldLoadedAt = nil
	w.snap.VersionAt = at(time.Now().Add(-10 * time.Minute))
	c, _ := newChecker(t, w, "")
	done := make(chan *Result)
	go func() { done <- c.check(context.Background(), TriggerStart, nil) }()
	select {
	case r := <-done:
		if ch := r.Check(CheckLogs); ch.Status != StatusWarn || ch.Reason != "world_loaded_missing" || r.Status != StatusWarn {
			t.Errorf("logs = %+v, status %s", ch, r.Status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("check hung")
	}

	// A cancelled agent stops waiting and keeps no result.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w.snap.VersionAt = at(time.Now())
	c.opt.WaitFor = time.Hour
	if r := c.check(ctx, TriggerStart, nil); r != nil {
		t.Errorf("cancelled check = %+v", r)
	}
}

func TestStart(t *testing.T) {
	w := started("l-1.0.20", 41, 3)
	w.snap.WorldLoadedAt = nil // keep it waiting
	c, events := newChecker(t, w, "")
	c.opt.WaitFor = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.base = ctx
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	if !c.View().Running {
		t.Error("not running")
	}
	if err := c.Start(); !errors.Is(err, ErrRunning) {
		t.Errorf("second start = %v", err)
	}
	c.Tick(ctx) // the loop waits its turn
	w.set(func(s *state.Snapshot, _ *worldmap.Health) { s.WorldLoadedAt = at(time.Now()) })
	deadline := time.Now().Add(5 * time.Second)
	for len(events.all()) < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	r := c.View().Result
	if r == nil || r.Trigger != TriggerManual || c.View().Running {
		t.Fatalf("manual = %+v", c.View())
	}
	if ev := events.all(); len(ev) != 2 || ev[0]["running"] != true || ev[1]["running"] != false {
		t.Errorf("events = %+v", ev)
	}
}

func TestManualBeforeTheVersionLine(t *testing.T) {
	// The agent restarted without the game: no version line, the kept build stands.
	w := &world{h: worldmap.Health{Generation: 3, Latest: 3, HasLatest: true, BuiltAt: time.Now()}}
	c, _ := newChecker(t, w, "")
	prev := &Result{Build: "l-1.0.20", NetworkVersion: 41, PreviousBuild: "l-1.0.17", Updated: true}
	r := c.check(context.Background(), TriggerManual, prev)
	if r.Build != "l-1.0.20" || r.PreviousBuild != "l-1.0.17" || !r.Updated {
		t.Errorf("result = %+v", r)
	}
	if ch := r.Check(CheckVersion); ch.Status != StatusWarn || ch.Reason != "not_seen" {
		t.Errorf("version = %+v", ch)
	}
	if ch := r.Check(CheckLogs); ch.Status != StatusSkipped {
		t.Errorf("logs = %+v", ch)
	}
	if r := c.check(context.Background(), TriggerManual, nil); r.Build != "" || r.Check(CheckVersion).Reason != "not_seen" {
		t.Errorf("without a kept result = %+v", r)
	}
}

func TestSaveCheck(t *testing.T) {
	built := worldmap.Health{Generation: 5, Latest: 5, HasLatest: true, BuiltAt: time.Now(), Chunks: 12}
	with := func(f func(h *worldmap.Health)) worldmap.Health { h := built; f(&h); return h }
	cases := []struct {
		name          string
		on            bool
		h             worldmap.Health
		pending, wait bool
		status, why   string
	}{
		{"no world", false, built, false, false, StatusSkipped, "no_world"},
		{"ok", true, built, false, false, StatusOK, ""},
		{"never saved", true, worldmap.Health{Failure: worldmap.FailNoSave}, false, false, StatusPending, "no_save"},
		{"never built", true, worldmap.Health{Failure: worldmap.FailIndex, HasLatest: true}, false, false, StatusFail, "not_built"},
		{"index", true, with(func(h *worldmap.Health) { h.Failure = worldmap.FailIndex }), false, false, StatusFail, "index_unreadable"},
		{"containers", true, with(func(h *worldmap.Health) { h.ContainersUnreadable = 41 }), true, false, StatusFail, "containers_unreadable"},
		{"chunks", true, with(func(h *worldmap.Health) { h.ChunksUnreadable = 1 }), false, false, StatusFail, "chunks_unreadable"},
		{"locations", true, with(func(h *worldmap.Health) { h.LocationsUnreadable = true }), false, false, StatusWarn, "locations_unreadable"},
		{"meta", true, with(func(h *worldmap.Health) { h.MetaUnreadable = true }), false, false, StatusWarn, "meta_unreadable"},
		{"behind", true, with(func(h *worldmap.Health) { h.Latest = 6 }), true, true, StatusWarn, "map_behind"},
		{"before the update's first save", true, built, true, false, StatusPending, "save_before_update"},
	}
	for _, tc := range cases {
		ch := saveCheck(tc.on, tc.h, tc.pending, tc.wait)
		if ch.Status != tc.status || ch.Reason != tc.why {
			t.Errorf("%s = %s/%s, want %s/%s", tc.name, ch.Status, ch.Reason, tc.status, tc.why)
		}
	}
}

func TestTerrainCheck(t *testing.T) {
	cases := []struct {
		name        string
		info        *terrain.Info
		status, why string
	}{
		{"none", nil, StatusSkipped, "not_configured"},
		{"off", &terrain.Info{}, StatusSkipped, "not_configured"},
		{"ok", &terrain.Info{Enabled: true, Available: true, Build: "b1"}, StatusOK, ""},
		{"new build", &terrain.Info{Enabled: true, Available: true, Stale: true, Reason: "gameBuild"}, StatusPending, "gameBuild"},
		{"other seed", &terrain.Info{Enabled: true, Available: true, Stale: true, Reason: "seed"}, StatusWarn, "seed"},
		{"missing", &terrain.Info{Enabled: true, Stale: true, Reason: "missing"}, StatusWarn, "missing"},
		{"unreadable", &terrain.Info{Enabled: true, Stale: true, Reason: "unreadable"}, StatusFail, "unreadable"},
	}
	for _, tc := range cases {
		info := tc.info
		ch := terrainCheck(func() *terrain.Info { return info })
		if ch.Status != tc.status || ch.Reason != tc.why {
			t.Errorf("%s = %s/%s, want %s/%s", tc.name, ch.Status, ch.Reason, tc.status, tc.why)
		}
	}
	if ch := terrainCheck(nil); ch.Status != StatusSkipped {
		t.Errorf("no terrain = %+v", ch)
	}
}

type fakeBridge bridge.Status

func (f fakeBridge) Status(context.Context) bridge.Status { return bridge.Status(f) }

func TestBridgeCheck(t *testing.T) {
	ok := bridge.Status{Available: true, Plugin: "0.2.0", GameBuild: "l-1.0.20", WorldLoaded: true, Tested: true}
	with := func(f func(s *bridge.Status)) fakeBridge { s := ok; f(&s); return fakeBridge(s) }
	cases := []struct {
		name        string
		b           BridgeSource
		status, why string
	}{
		{"not configured", nil, StatusSkipped, "not_configured"},
		{"ok", fakeBridge(ok), StatusOK, ""},
		{"same build without the branch letter", with(func(s *bridge.Status) { s.GameBuild = "1.0.20" }), StatusOK, ""},
		{"unreachable", fakeBridge(bridge.Status{Reason: "unreachable"}), StatusFail, "unreachable"},
		{"disabled", fakeBridge(bridge.Status{Reason: "disabled", Message: "plugin disabled"}), StatusFail, "disabled"},
		{"token", fakeBridge(bridge.Status{Reason: "token"}), StatusFail, "token"},
		{"loading", fakeBridge(bridge.Status{Reason: "loading", GameBuild: "l-1.0.20"}), StatusWarn, "loading"},
		{"other build", with(func(s *bridge.Status) { s.GameBuild = "l-1.0.19" }), StatusWarn, "build_mismatch"},
		{"untested", with(func(s *bridge.Status) { s.Tested = false }), StatusWarn, "untested"},
		{"acknowledged", with(func(s *bridge.Status) { s.Tested, s.Acknowledged = false, true }), StatusOK, "acknowledged"},
	}
	for _, tc := range cases {
		c := New(Options{State: func() state.Snapshot { return state.Snapshot{} }, Bridge: tc.b, Logger: quiet})
		ch := c.bridgeCheck(context.Background(), "l-1.0.20")
		if ch.Status != tc.status || ch.Reason != tc.why {
			t.Errorf("%s = %s/%s, want %s/%s", tc.name, ch.Status, ch.Reason, tc.status, tc.why)
		}
	}
	c := New(Options{Bridge: fakeBridge(ok), Logger: quiet})
	if ch := c.bridgeCheck(context.Background(), "l-1.0.20"); ch.Detail["plugin"] != "0.2.0" || ch.Detail["gameBuild"] != "l-1.0.20" {
		t.Errorf("detail = %+v", ch.Detail)
	}
}

func TestLogsCheck(t *testing.T) {
	v := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	plus := func(d time.Duration) *time.Time { return at(v.Add(d)) }
	late := v.Add(time.Hour)
	cases := []struct {
		name        string
		s           state.Snapshot
		crossplay   bool
		now         time.Time
		status, why string
	}{
		{"not seen", state.Snapshot{}, false, late, StatusSkipped, "not_seen"},
		{"loaded", state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(25 * time.Second)}, false, late, StatusOK, ""},
		{"loaded and joined", state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(25 * time.Second), JoinCodeSeenAt: plus(28 * time.Second)}, true, late, StatusOK, ""},
		{"still loading", state.Snapshot{VersionAt: &v}, false, v.Add(time.Minute), StatusPending, "world_loading"},
		{"never loaded", state.Snapshot{VersionAt: &v}, false, late, StatusWarn, "world_loaded_missing"},
		{"loaded slowly", state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(10 * time.Minute)}, false, late, StatusOK, ""},
		{"loaded by the game before", state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(-time.Hour)}, false, late, StatusWarn, "world_loaded_missing"},
		{"join code waiting", state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(25 * time.Second)}, true, v.Add(time.Minute), StatusPending, "join_code_waiting"},
		{"no join code", state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(25 * time.Second), JoinCodeSeenAt: plus(-time.Hour)}, true, late, StatusWarn, "join_code_missing"},
		{"no join code needed", state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(25 * time.Second)}, false, late, StatusOK, ""},
	}
	for _, tc := range cases {
		ch := logsCheck(tc.s, tc.crossplay, 5*time.Minute, tc.now)
		if ch.Status != tc.status || ch.Reason != tc.why {
			t.Errorf("%s = %s/%s, want %s/%s", tc.name, ch.Status, ch.Reason, tc.status, tc.why)
		}
	}
	ch := logsCheck(state.Snapshot{VersionAt: &v, WorldLoadedAt: plus(25 * time.Second), JoinCodeSeenAt: plus(28 * time.Second)}, true, 5*time.Minute, late)
	if ch.Detail["worldLoadedSeconds"] != 25 || ch.Detail["joinCode"] != true {
		t.Errorf("detail = %+v", ch.Detail)
	}
}

func TestVersionCheckAndOverall(t *testing.T) {
	if ch := versionCheck(&Result{Build: "l-1.0.20"}, true); ch.Status != StatusOK || ch.Reason != "first" {
		t.Errorf("first = %+v", ch)
	}
	if ch := versionCheck(&Result{Build: "l-1.0.20", PreviousBuild: "l-1.0.20"}, true); ch.Reason != "unchanged" {
		t.Errorf("unchanged = %+v", ch)
	}
	if ch := versionCheck(&Result{Build: "l-1.0.20", NetworkVersion: 40, PreviousBuild: "l-1.0.17", PreviousNetworkVersion: 40, Updated: true}, true); ch.Reason != "updated" || ch.Detail["networkChanged"] != false {
		t.Errorf("updated = %+v", ch)
	}
	checks := func(ss ...string) []Check {
		var out []Check
		for _, s := range ss {
			out = append(out, Check{Status: s})
		}
		return out
	}
	for want, cs := range map[string][]Check{
		StatusOK:   checks(StatusOK, StatusSkipped, StatusPending),
		StatusWarn: checks(StatusOK, StatusWarn, StatusPending),
		StatusFail: checks(StatusWarn, StatusFail, StatusOK),
	} {
		if got := Overall(cs); got != want {
			t.Errorf("overall %v = %s, want %s", cs, got, want)
		}
	}
	if Overall(nil) != StatusOK {
		t.Error("no checks is not ok")
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "compat.json")
	w := started("l-1.0.20", 41, 3)
	c, _ := newChecker(t, w, path)
	c.Tick(context.Background())
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var s stored
	if err := json.Unmarshal(raw, &s); err != nil || s.Result == nil || s.Result.Build != "l-1.0.20" || len(s.Result.Checks) != len(CheckNames) {
		t.Fatalf("stored = %s (%v)", raw, err)
	}
	for i, name := range CheckNames {
		if s.Result.Checks[i].Name != name {
			t.Errorf("check %d = %s, want %s", i, s.Result.Checks[i].Name, name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, ".compat.tmp")); err == nil {
		t.Error("temp file left")
	}
	// A broken file starts afresh.
	if err := os.WriteFile(path, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if c, _ := newChecker(t, w, path); c.View().Result != nil {
		t.Error("broken file loaded")
	}
	// An unwritable directory keeps the result in memory.
	c4, _ := newChecker(t, w, filepath.Join(dir, "missing", "compat.json"))
	c4.Tick(context.Background())
	if c4.View().Result == nil {
		t.Error("no result without a writable directory")
	}
	if strings.Contains(string(raw), "worlds_local") {
		t.Error("a path in the stored result")
	}
}

func TestOneSaveStartsOneCheck(t *testing.T) {
	// A world whose saves never reach the map (no finished generation): the
	// save check stays pending, and the loop must not check again and again.
	w := started("l-1.0.20", 41, 0)
	w.h = worldmap.Health{Failure: worldmap.FailNoSave}
	c, events := newChecker(t, w, "")
	c.result = &Result{Build: "l-1.0.17"}
	ctx := context.Background()
	c.Tick(ctx)
	if r := c.View().Result; r.Trigger != TriggerUpdate || r.AwaitingSave {
		t.Fatalf("update = %+v", r)
	}
	// Even a result that waits for a save re-checks once per save.
	w.set(func(s *state.Snapshot, _ *worldmap.Health) { s.LastSaveAt = at(time.Now()) })
	c.mu.Lock()
	c.result.AwaitingSave = true
	c.mu.Unlock()
	c.Tick(ctx)
	n := len(events.all())
	c.mu.Lock()
	c.result.AwaitingSave = true
	c.mu.Unlock()
	for range 3 {
		c.Tick(ctx)
	}
	if got := len(events.all()); got != n {
		t.Errorf("checked %d more times after one save", (got-n)/2)
	}
}

func TestManualCheckOfANewBuildIsTheUpdate(t *testing.T) {
	w := started("l-1.0.20", 41, 3)
	w.snap.LastSaveAt = at(time.Now().Add(-5 * time.Minute)) // the old game's save
	c, _ := newChecker(t, w, "")
	r := c.check(context.Background(), TriggerManual, &Result{Build: "l-1.0.17", NetworkVersion: 40})
	if r.Trigger != TriggerUpdate || !r.Updated || !r.AwaitingSave || r.PreviousBuild != "l-1.0.17" {
		t.Errorf("manual first check of a new build = %+v", r)
	}
}

type slowBridge struct {
	mu    sync.Mutex
	calls int
}

func (b *slowBridge) Status(context.Context) bridge.Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.calls++
	if b.calls < 3 {
		return bridge.Status{Reason: "loading", GameBuild: "l-1.0.20"}
	}
	return bridge.Status{Available: true, Plugin: "0.2.0", GameBuild: "l-1.0.20", WorldLoaded: true, Tested: true}
}

func TestWaitsForTheBridgeToLoad(t *testing.T) {
	w := started("l-1.0.20", 41, 3)
	c, _ := newChecker(t, w, "")
	c.opt.WaitFor = 5 * time.Second
	c.opt.Bridge = &slowBridge{}
	r := c.check(context.Background(), TriggerStart, nil)
	if ch := r.Check(CheckBridge); ch.Status != StatusOK {
		t.Errorf("bridge = %+v", ch)
	}
}
