package saferestart

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/krystianslowik/skald/agent/internal/restore"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
)

// A fictional world; never a real one.
const world = "Testheim"

type fakeSup struct {
	mu        sync.Mutex
	state     map[string]string
	calls     []string
	failStop  error
	failStart error
	onStart   func()
	// whileStopped runs once the game is down (the world is quiet).
	whileStopped func()
}

func newFakeSup() *fakeSup {
	return &fakeSup{state: map[string]string{restore.ServerProgram: "RUNNING", restore.UpdaterProgram: "RUNNING"}}
}

func (f *fakeSup) GetAllProcessInfo(context.Context) ([]supervisor.ProcessInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []supervisor.ProcessInfo
	for n, s := range f.state {
		out = append(out, supervisor.ProcessInfo{Name: n, StateName: s})
	}
	return out, nil
}

func (f *fakeSup) StopProcess(_ context.Context, name string, _ bool) error {
	f.mu.Lock()
	f.calls = append(f.calls, "stop "+name)
	if name == restore.ServerProgram && f.failStop != nil {
		f.mu.Unlock()
		return f.failStop
	}
	f.state[name] = "STOPPED"
	hook := f.whileStopped
	f.mu.Unlock()
	if name == restore.ServerProgram && hook != nil {
		hook()
	}
	return nil
}

func (f *fakeSup) StartProcess(_ context.Context, name string, _ bool) error {
	f.mu.Lock()
	f.calls = append(f.calls, "start "+name)
	if name == restore.ServerProgram && f.failStart != nil {
		f.mu.Unlock()
		return f.failStart
	}
	f.state[name] = "RUNNING"
	hook := f.onStart
	f.mu.Unlock()
	if name == restore.ServerProgram && hook != nil {
		hook()
	}
	return nil
}

func (f *fakeSup) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

type fakeBridge struct {
	mu        sync.Mutex
	available bool
	said      []string
	saves     int
	saveErr   error
	// onSave runs after a save was asked for (the game writes it).
	onSave func()
}

func (b *fakeBridge) Available(context.Context) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.available
}

func (b *fakeBridge) Broadcast(_ context.Context, text, _ string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.said = append(b.said, text)
	return nil
}

func (b *fakeBridge) Save(context.Context, string) error {
	b.mu.Lock()
	b.saves++
	err, hook := b.saveErr, b.onSave
	b.mu.Unlock()
	if err == nil && hook != nil {
		hook()
	}
	return err
}

func (b *fakeBridge) Said() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.said...)
}

// game is the log tracker's view, as the test moves it.
type game struct {
	mu   sync.Mutex
	snap state.Snapshot
}

func (g *game) State() state.Snapshot {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.snap
}

func (g *game) set(fn func(s *state.Snapshot)) {
	g.mu.Lock()
	fn(&g.snap)
	g.mu.Unlock()
}

// boots makes a started game log its world loaded and a new code.
func (g *game) boots(code string) func() {
	return func() {
		go func() {
			time.Sleep(5 * time.Millisecond)
			now := time.Now()
			g.set(func(s *state.Snapshot) {
				s.Status = state.StatusRunning
				s.WorldLoadedAt = &now
				s.JoinCodeSeenAt = &now
				s.JoinCode = code
			})
		}()
	}
}

type harness struct {
	t      *testing.T
	dir    string
	sup    *fakeSup
	bridge *fakeBridge
	game   *game
	mu     sync.Mutex
	events []string
	runs   []View
	lockMu sync.Mutex
	locked bool
	opt    Options
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	w := filepath.Join(dir, "worlds_local", world)
	if err := os.MkdirAll(w, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"_main.3.db2": "db-three", "_main.3.fwl2": "fwl-three", "_main.3.ok": "", "_main.2.db2": "db-two", "_main.2.fwl2": "fwl-two", "_main.2.ok": "", "chunk_0_0.chunk": "chunk"} {
		if err := os.WriteFile(filepath.Join(w, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := &harness{t: t, dir: dir, sup: newFakeSup(), bridge: &fakeBridge{available: true}, game: &game{}}
	h.game.snap = state.Snapshot{Status: state.StatusRunning, JoinCode: "000001"}
	h.sup.onStart = h.game.boots("123456")
	h.bridge.onSave = func() {
		now := time.Now()
		h.game.set(func(s *state.Snapshot) { s.LastSaveAt = &now })
	}
	h.opt = Options{
		ConfigDir:  dir,
		World:      world,
		Supervisor: h.sup,
		State:      h.game.State,
		Bridge:     h.bridge,
		Crossplay:  func() bool { return true },
		Lock: func() bool {
			h.lockMu.Lock()
			defer h.lockMu.Unlock()
			if h.locked {
				return false
			}
			h.locked = true
			return true
		},
		Unlock: func() {
			h.lockMu.Lock()
			h.locked = false
			h.lockMu.Unlock()
		},
		Publish: func(step, result string, v View) {
			h.mu.Lock()
			h.events = append(h.events, step+":"+result)
			h.runs = append(h.runs, v)
			h.mu.Unlock()
		},
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Tick:           time.Millisecond,
		EmptyFor:       20 * time.Millisecond,
		Minute:         60 * time.Millisecond,
		LockWait:       30 * time.Millisecond,
		SaveTimeout:    200 * time.Millisecond,
		ActionTimeout:  time.Second,
		RecoverTimeout: 500 * time.Millisecond,
	}
	return h
}

func (h *harness) Events() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.events...)
}

func (h *harness) run(req Request) *View {
	h.t.Helper()
	r := New(h.opt)
	if _, err := r.Start(req, "Ragnar"); err != nil {
		h.t.Fatal(err)
	}
	r.Wait()
	return r.View()
}

func stepStates(v *View) map[string]string {
	out := map[string]string{}
	for _, s := range v.Steps {
		out[s.Name] = s.State
	}
	return out
}

func wantStates(t *testing.T, v *View, want map[string]string) {
	t.Helper()
	got := stepStates(v)
	for k, w := range want {
		if got[k] != w {
			t.Errorf("step %s: %s, want %s (all: %v; error %q)", k, got[k], w, got, v.Error)
		}
	}
}

func TestHappyPathEmptyServer(t *testing.T) {
	h := newHarness(t)
	v := h.run(Request{WarnMinutes: 5})
	if v.State != RunDone {
		t.Fatalf("state %s, error %q", v.State, v.Error)
	}
	wantStates(t, v, map[string]string{StepWait: Skipped, StepCountdown: Skipped, StepSave: OK, StepStop: OK, StepBackup: OK, StepVerify: OK, StepStart: OK, StepRecover: OK})
	if v.JoinCode != "123456" {
		t.Errorf("join code %q", v.JoinCode)
	}
	if !archiveName.MatchString(v.Archive) || v.ArchiveBytes == 0 || len(v.ArchiveSHA256) != 64 {
		t.Errorf("archive %q %d %q", v.Archive, v.ArchiveBytes, v.ArchiveSHA256)
	}
	// The updater was paused around the zip and came back after the game.
	want := []string{"stop valheim-updater", "stop valheim-server", "start valheim-server", "start valheim-updater"}
	if got := h.sup.Calls(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("calls %v, want %v", got, want)
	}
	if h.locked {
		t.Error("action lock still held")
	}
	// Nobody on: no warnings at all.
	if said := h.bridge.Said(); len(said) != 0 {
		t.Errorf("broadcasts %v", said)
	}
	ev := h.Events()
	if ev[0] != "begin:running" || ev[len(ev)-1] != "end:done" {
		t.Errorf("events %v", ev)
	}
	// The archive is listed for a restore.
	found := false
	for _, b := range restore.List(h.dir) {
		if b.Name == v.Archive && b.Source == restore.SourceSkald {
			found = true
		}
	}
	if !found {
		t.Errorf("archive %s not in the restore list", v.Archive)
	}
}

func TestBackupIsOfTheStoppedWorld(t *testing.T) {
	h := newHarness(t)
	// The shutdown save writes a newer generation; the archive must have it.
	h.sup.whileStopped = func() {
		w := filepath.Join(h.dir, "worlds_local", world)
		_ = os.WriteFile(filepath.Join(w, "_main.4.db2"), []byte("db-four"), 0o644)
		_ = os.WriteFile(filepath.Join(w, "_main.4.fwl2"), []byte("fwl-four"), 0o644)
		_ = os.WriteFile(filepath.Join(w, "_main.4.ok"), nil, 0o644)
	}
	v := h.run(Request{})
	if v.State != RunDone {
		t.Fatalf("state %s, error %q", v.State, v.Error)
	}
	zr, err := zip.OpenReader(filepath.Join(h.dir, restore.SkaldDir, v.Archive))
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var has bool
	for _, f := range zr.File {
		if f.Name == "worlds_local/"+world+"/_main.4.db2" {
			has = true
		}
	}
	if !has {
		t.Error("the archive misses the shutdown save")
	}
}

func TestCountdownWarnsPlayersAndEndsEarlyWhenTheyLeave(t *testing.T) {
	h := newHarness(t)
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 2 })
	// They leave after the first warnings.
	go func() {
		for len(h.bridge.Said()) < 2 {
			time.Sleep(time.Millisecond)
		}
		h.game.set(func(s *state.Snapshot) { s.PlayersReported = 0 })
	}()
	v := h.run(Request{WarnMinutes: 2, Locale: "pl"})
	if v.State != RunDone {
		t.Fatalf("state %s, error %q", v.State, v.Error)
	}
	said := h.bridge.Said()
	if len(said) < 2 || said[0] != "Restart serwera za 2 min. Znajdźcie bezpieczne miejsce." {
		t.Fatalf("broadcasts %v", said)
	}
	cd := v.step(StepCountdown)
	if cd.State != OK || cd.Reason != "emptied" {
		t.Errorf("countdown %+v", cd)
	}
	if !v.Warned || v.RestartAt == nil {
		t.Errorf("warned %v restartAt %v", v.Warned, v.RestartAt)
	}
}

func TestCountdownRunsToTheEndWithAllMarks(t *testing.T) {
	h := newHarness(t)
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 1 })
	v := h.run(Request{WarnMinutes: 1})
	if v.State != RunDone {
		t.Fatalf("state %s, error %q", v.State, v.Error)
	}
	said := h.bridge.Said()
	// 1 min, 30 s, 10 s, then "now" before the save.
	want := []string{"The server restarts in 1 min. Find a safe spot.", "The server restarts in 30 s.", "The server restarts in 10 s.", "The server restarts now. Back in a few minutes."}
	if strings.Join(said, "|") != strings.Join(want, "|") {
		t.Errorf("broadcasts %q, want %q", said, want)
	}
}

func TestCountdownWithoutBridgeStillWaits(t *testing.T) {
	h := newHarness(t)
	h.opt.Bridge = nil
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 1 })
	start := time.Now()
	v := h.run(Request{WarnMinutes: 1})
	if v.State != RunDone {
		t.Fatalf("state %s, error %q", v.State, v.Error)
	}
	if time.Since(start) < 60*time.Millisecond {
		t.Error("the countdown did not wait")
	}
	wantStates(t, v, map[string]string{StepCountdown: OK, StepSave: Skipped})
	if v.step(StepCountdown).Reason != "nobridge" || v.Warned {
		t.Errorf("countdown %+v warned %v", v.step(StepCountdown), v.Warned)
	}
}

func TestWaitForEmpty(t *testing.T) {
	h := newHarness(t)
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 1 })
	r := New(h.opt)
	if _, err := r.Start(Request{WhenEmpty: true, WarnMinutes: 5}, "Freya"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if v := r.View(); v.Step != StepWait || v.step(StepWait).State != Running {
		t.Fatalf("not waiting: %+v", v)
	}
	if len(h.sup.Calls()) != 0 {
		t.Fatal("touched the game while waiting")
	}
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 0 })
	r.Wait()
	v := r.View()
	if v.State != RunDone || v.Forced {
		t.Fatalf("state %s forced %v error %q", v.State, v.Forced, v.Error)
	}
	wantStates(t, v, map[string]string{StepWait: OK, StepCountdown: Skipped})
	if v.step(StepWait).Reason != "empty" {
		t.Errorf("wait reason %q", v.step(StepWait).Reason)
	}
}

func TestWaitIgnoresAShortEmptySpell(t *testing.T) {
	h := newHarness(t)
	h.opt.EmptyFor = 80 * time.Millisecond
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 1 })
	r := New(h.opt)
	if _, err := r.Start(Request{WhenEmpty: true}, "Freya"); err != nil {
		t.Fatal(err)
	}
	// Empty for a moment (a reconnect), then back.
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 0 })
	time.Sleep(20 * time.Millisecond)
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 1 })
	time.Sleep(100 * time.Millisecond)
	if !r.Active() || r.View().Step != StepWait {
		t.Fatalf("went ahead on a short empty spell: %+v", r.View())
	}
	if err := r.Cancel("Freya"); err != nil {
		t.Fatal(err)
	}
	r.Wait()
}

func TestWaitSitsOutAStartingServer(t *testing.T) {
	h := newHarness(t)
	h.game.set(func(s *state.Snapshot) { s.Status = "starting" })
	r := New(h.opt)
	if _, err := r.Start(Request{WhenEmpty: true}, "Freya"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if v := r.View(); v.Step != StepWait || v.State != RunActive {
		t.Fatalf("went ahead on a booting server: %+v", v)
	}
	h.game.set(func(s *state.Snapshot) { s.Status = "stopped" })
	r.Wait()
	if v := r.View(); v.State != RunDone || v.step(StepWait).Reason != "empty" {
		t.Fatalf("view %+v", v)
	}
}

func TestErrorsCarryNoPaths(t *testing.T) {
	if got := scrub(errors.New("backup: open /config/skald-backups/.pre-restart-1.tmp: permission denied")); got != "backup: open .pre-restart-1.tmp: permission denied" {
		t.Errorf("scrub = %q", got)
	}
	h := newHarness(t)
	if err := os.WriteFile(filepath.Join(h.dir, restore.SkaldDir), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	v := h.run(Request{})
	if strings.Contains(v.Error, h.dir) || strings.Contains(v.step(StepBackup).Error, h.dir) {
		t.Errorf("errors leak a path: %q / %q", v.Error, v.step(StepBackup).Error)
	}
}

func TestDeadlineForcesTheCountdown(t *testing.T) {
	h := newHarness(t)
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 3 })
	v := h.run(Request{WhenEmpty: true, DeadlineMinutes: 1, WarnMinutes: 1})
	if v.State != RunDone {
		t.Fatalf("state %s, error %q", v.State, v.Error)
	}
	if !v.Forced || v.step(StepWait).Reason != "deadline" || v.Deadline == nil {
		t.Errorf("forced %v wait %+v deadline %v", v.Forced, v.step(StepWait), v.Deadline)
	}
	wantStates(t, v, map[string]string{StepCountdown: OK})
	if len(h.bridge.Said()) == 0 {
		t.Error("players were not warned after the deadline")
	}
}

func TestCancelWhileWaitingAndCountingDown(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  Request
		step string
	}{
		{"wait", Request{WhenEmpty: true, WarnMinutes: 1}, StepWait},
		{"countdown", Request{WarnMinutes: 10}, StepCountdown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.game.set(func(s *state.Snapshot) { s.PlayersReported = 1 })
			r := New(h.opt)
			if _, err := r.Start(tc.req, "Bjorn"); err != nil {
				t.Fatal(err)
			}
			for r.View().Step != tc.step || r.View().step(tc.step).State != Running {
				time.Sleep(time.Millisecond)
			}
			time.Sleep(5 * time.Millisecond)
			if err := r.Cancel("Astrid"); err != nil {
				t.Fatal(err)
			}
			r.Wait()
			v := r.View()
			if v.State != RunCancelled || v.CancelledBy != "Astrid" || v.step(tc.step).State != Cancelled {
				t.Fatalf("view %+v", v)
			}
			if len(h.sup.Calls()) != 0 {
				t.Errorf("game touched: %v", h.sup.Calls())
			}
			said := h.bridge.Said()
			if tc.step == StepCountdown && (len(said) < 2 || said[len(said)-1] != "The server restart is called off.") {
				t.Errorf("broadcasts %v", said)
			}
			if tc.step == StepWait && len(said) != 0 {
				t.Errorf("broadcasts while waiting: %v", said)
			}
			if !errors.Is(r.Cancel("Astrid"), ErrNotFound) {
				t.Error("second cancel did not say there is nothing to cancel")
			}
		})
	}
}

func TestCancelAfterThePointOfNoReturn(t *testing.T) {
	h := newHarness(t)
	block := make(chan struct{})
	h.bridge.onSave = func() { <-block }
	r := New(h.opt)
	if _, err := r.Start(Request{}, "Bjorn"); err != nil {
		t.Fatal(err)
	}
	for r.View().Step != StepSave {
		time.Sleep(time.Millisecond)
	}
	if err := r.Cancel("Bjorn"); !errors.Is(err, ErrTooLate) {
		t.Errorf("cancel: %v", err)
	}
	close(block)
	r.Wait()
	if v := r.View(); v.State != RunDone {
		t.Errorf("state %s %q", v.State, v.Error)
	}
}

func TestOneRunAtATime(t *testing.T) {
	h := newHarness(t)
	h.game.set(func(s *state.Snapshot) { s.PlayersReported = 1 })
	r := New(h.opt)
	if _, err := r.Start(Request{WhenEmpty: true}, "Bjorn"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Start(Request{}, "Freya"); !errors.Is(err, ErrActive) {
		t.Errorf("second start: %v", err)
	}
	_ = r.Cancel("Bjorn")
	r.Wait()
}

func TestRequestValidation(t *testing.T) {
	h := newHarness(t)
	r := New(h.opt)
	for _, req := range []Request{{WarnMinutes: -1}, {WarnMinutes: 31}, {WhenEmpty: true, DeadlineMinutes: 24*60 + 1}, {WhenEmpty: true, DeadlineMinutes: -5}} {
		if _, err := r.Start(req, "x"); err == nil {
			t.Errorf("accepted %+v", req)
		}
	}
	h.opt.World = ""
	if _, err := New(h.opt).Start(Request{}, "x"); err == nil {
		t.Error("started without a world")
	}
	req := Request{DeadlineMinutes: 30, Locale: "xx"}
	if err := req.Validate(); err != nil || req.DeadlineMinutes != 0 || req.Locale != "en" {
		t.Errorf("normalised to %+v (%v)", req, err)
	}
}

func TestSaveFailureIsOnlyAWarning(t *testing.T) {
	h := newHarness(t)
	h.bridge.saveErr = errors.New("bridge 503: loading")
	v := h.run(Request{})
	if v.State != RunDone {
		t.Fatalf("state %s, error %q", v.State, v.Error)
	}
	if s := v.step(StepSave); s.State != Warn || s.Reason != "failed" {
		t.Errorf("save %+v", s)
	}
}

func TestSaveWithoutSaveLineIsAWarning(t *testing.T) {
	h := newHarness(t)
	h.bridge.onSave = nil
	v := h.run(Request{})
	if s := v.step(StepSave); s.State != Warn || s.Reason != "nosave" || v.State != RunDone {
		t.Errorf("save %+v run %s", s, v.State)
	}
}

func TestStopFailureStartsTheGameAndFails(t *testing.T) {
	h := newHarness(t)
	h.sup.failStop = errors.New("timeout")
	v := h.run(Request{})
	if v.State != RunFailed || !strings.Contains(v.Error, "stop") {
		t.Fatalf("state %s error %q", v.State, v.Error)
	}
	wantStates(t, v, map[string]string{StepStop: Failed, StepBackup: Pending})
	calls := h.sup.Calls()
	if calls[len(calls)-2] != "start valheim-server" {
		t.Errorf("calls %v", calls)
	}
}

func TestBackupFailureStillStartsTheGame(t *testing.T) {
	h := newHarness(t)
	// A file named like the archive's directory makes the zip impossible.
	if err := os.WriteFile(filepath.Join(h.dir, restore.SkaldDir), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	v := h.run(Request{})
	if v.State != RunFailed || !strings.Contains(v.Error, "backup") {
		t.Fatalf("state %s error %q", v.State, v.Error)
	}
	wantStates(t, v, map[string]string{StepBackup: Failed, StepVerify: Skipped, StepStart: OK, StepRecover: OK})
	if v.JoinCode != "123456" {
		t.Errorf("join code %q", v.JoinCode)
	}
}

func TestVerifyFailureKeepsTheGameUpAndTheRunFails(t *testing.T) {
	h := newHarness(t)
	// The newest finished save lost its .fwl2: the archive is not a whole world.
	h.sup.whileStopped = func() {
		_ = os.Remove(filepath.Join(h.dir, "worlds_local", world, "_main.3.fwl2"))
	}
	v := h.run(Request{})
	if v.State != RunFailed || !strings.Contains(v.Error, "verify") {
		t.Fatalf("state %s error %q", v.State, v.Error)
	}
	wantStates(t, v, map[string]string{StepBackup: OK, StepVerify: Failed, StepStart: OK, StepRecover: OK})
	// Kept for inspection.
	if _, err := os.Stat(filepath.Join(h.dir, restore.SkaldDir, v.Archive)); err != nil {
		t.Errorf("archive gone: %v", err)
	}
}

func TestStartFailure(t *testing.T) {
	h := newHarness(t)
	h.sup.failStart = errors.New("SPAWN_ERROR")
	v := h.run(Request{})
	if v.State != RunFailed || !strings.Contains(v.Error, "start") {
		t.Fatalf("state %s error %q", v.State, v.Error)
	}
	wantStates(t, v, map[string]string{StepVerify: OK, StepStart: Failed, StepRecover: Pending})
	if v.Archive == "" {
		t.Error("no archive kept")
	}
}

func TestRecoverWaitsForJoinCode(t *testing.T) {
	h := newHarness(t)
	// The world loads, but no code comes.
	h.sup.onStart = func() {
		now := time.Now()
		h.game.set(func(s *state.Snapshot) { s.WorldLoadedAt = &now })
	}
	v := h.run(Request{})
	if v.State != RunFailed {
		t.Fatalf("state %s", v.State)
	}
	if s := v.step(StepRecover); s.State != Failed || s.Reason != "join_code_missing" {
		t.Errorf("recover %+v", s)
	}
}

func TestRecoverWithoutCrossplayNeedsNoCode(t *testing.T) {
	h := newHarness(t)
	h.opt.Crossplay = func() bool { return false }
	h.sup.onStart = func() {
		now := time.Now()
		h.game.set(func(s *state.Snapshot) { s.WorldLoadedAt = &now })
	}
	v := h.run(Request{})
	if v.State != RunDone || v.JoinCode != "" {
		t.Fatalf("state %s code %q error %q", v.State, v.JoinCode, v.Error)
	}
}

func TestRecoverWorldNeverLoads(t *testing.T) {
	h := newHarness(t)
	h.sup.onStart = nil
	v := h.run(Request{})
	if s := v.step(StepRecover); s.State != Failed || s.Reason != "world_not_loaded" || v.State != RunFailed {
		t.Errorf("recover %+v run %s", s, v.State)
	}
}

func TestBusyLock(t *testing.T) {
	h := newHarness(t)
	h.locked = true
	v := h.run(Request{})
	if v.State != RunFailed || v.step(StepSave).Reason != "busy" {
		t.Fatalf("view %+v", v)
	}
	if len(h.sup.Calls()) != 0 {
		t.Error("game touched while another action held the lock")
	}
}

func TestPruneKeepsTheNewest(t *testing.T) {
	h := newHarness(t)
	h.opt.Keep = 2
	dir := filepath.Join(h.dir, restore.SkaldDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"pre-restart-20260101-000000.zip", "pre-restart-20260102-000000.zip", "pre-restart-20260103-000000.zip", "pre-restore-20250101-000000.zip"} {
		_ = os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644)
		_ = os.WriteFile(filepath.Join(dir, n+".sha256"), []byte("x"), 0o644)
	}
	v := h.run(Request{})
	if v.State != RunDone {
		t.Fatal(v.Error)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "*.zip"))
	var names []string
	for _, p := range left {
		names = append(names, filepath.Base(p))
	}
	// This run's and the newest old one; pre-restore copies are not ours to prune.
	want := []string{"pre-restart-20260103-000000.zip", v.Archive, "pre-restore-20250101-000000.zip"}
	if len(names) != 3 || !contains(names, want[0]) || !contains(names, want[1]) || !contains(names, want[2]) {
		t.Errorf("left %v", names)
	}
	if _, err := os.Stat(filepath.Join(dir, "pre-restart-20260101-000000.zip.sha256")); err == nil {
		t.Error("checksum file of a pruned archive left behind")
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestMarks(t *testing.T) {
	m := time.Minute
	got := marks(10*m, m)
	want := []time.Duration{10 * m, 5 * m, 2 * m, m, 30 * time.Second, 10 * time.Second}
	if len(got) != len(want) {
		t.Fatalf("marks %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("marks %v", got)
		}
	}
}

// ---- Verify ------------------------------------------------------------------

func writeZip(t *testing.T, entries map[string]string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	w := filepath.Join(dir, "worlds_local", world)
	if err := os.MkdirAll(w, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range entries {
		p := filepath.Join(dir, "worlds_local", filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p, digest, err := restore.Archive(dir, world, filepath.Join(dir, "out"), Prefix, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	return p, digest
}

func TestVerify(t *testing.T) {
	gen := map[string]string{world + "/_main.7.db2": "d", world + "/_main.7.fwl2": "f", world + "/_main.7.ok": ""}
	p, digest := writeZip(t, gen)
	if n, err := Verify(p, digest, world); err != nil || n == 0 {
		t.Fatalf("whole world: %d %v", n, err)
	}
	if _, err := Verify(p, strings.Repeat("0", 64), world); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Errorf("wrong digest: %v", err)
	}
	// The checksum file must agree.
	_ = os.WriteFile(p+".sha256", []byte(strings.Repeat("1", 64)+"  x\n"), 0o644)
	if _, err := Verify(p, digest, world); err == nil {
		t.Error("checksum file mismatch accepted")
	}

	// Pre-1.0 flat pair.
	p, digest = writeZip(t, map[string]string{world + ".db": "d", world + ".fwl": "f"})
	if _, err := Verify(p, digest, world); err != nil {
		t.Errorf("flat pair: %v", err)
	}
	// Half a pair, or an empty half, is not a world.
	for _, entries := range []map[string]string{
		{world + ".db": "d"},
		{world + "/_main.7.db2": "d", world + "/_main.7.ok": ""},
		{world + "/_main.7.db2": "d", world + "/_main.7.fwl2": "", world + "/_main.7.ok": ""},
		// Generation 8 finished but only 7 is whole.
		{world + "/_main.7.db2": "d", world + "/_main.7.fwl2": "f", world + "/_main.8.db2": "d", world + "/_main.8.ok": ""},
		{"Otherheim/_main.1.db2": "d", "Otherheim/_main.1.fwl2": "f"},
	} {
		p, digest := writeZip(t, entries)
		if _, err := Verify(p, digest, world); err == nil {
			t.Errorf("accepted %v", entries)
		}
	}
	// A truncated archive fails on its sha256 already; one with a broken CRC on the read.
	p, digest = writeZip(t, gen)
	raw, _ := os.ReadFile(p)
	_ = os.WriteFile(p, raw[:len(raw)/2], 0o644)
	if _, err := Verify(p, digest, world); err == nil {
		t.Error("truncated archive accepted")
	}
}
