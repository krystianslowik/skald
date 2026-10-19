// Package saferestart restarts the game the careful way an owner would by
// hand, as one run with visible steps:
//
//  1. wait: optionally, until nobody plays (held for EmptyFor), or until a
//     deadline, after which the run goes ahead with players on;
//  2. countdown: with players on, warn them in game (through the bridge, when
//     installed) at fixed marks, and let skald-web tell Discord and phones;
//  3. save: ask the game to save (bridge only) and wait for the save line;
//  4. stop: the game (and the image's updater, which could start it again on
//     its own) through supervisord, which waits for the shutdown save;
//  5. backup: zip the stopped world into CONFIG_DIR/skald-backups/
//     pre-restart-<time>.zip, with a .sha256 next to it;
//  6. verify: read the archive back: size, sha256, every entry's CRC, and a
//     complete world (the newest finished save generation's .db2 + .fwl2, or
//     the pre-1.0 .db + .fwl pair);
//  7. start: the game, then the updater (the image updates the game on start
//     when it does that);
//  8. recover: wait for the log to report the world loaded and, with
//     crossplay, a new join code, which the run then carries.
//
// The run lives in the agent, next to supervisord, the log tracker and the
// bridge, so it goes on when skald-web restarts; skald-web reads it back from
// /state and the event stream. Every step change is one `restart_run` event
// carrying the whole run, so the Saga holds the run and a panel that missed
// events catches up from any one of them.
//
// A failed backup or verify never leaves the game down: the world was not
// touched, so the game is started again and the run ends failed. Every
// archive is kept (the newest Keep of them).
package saferestart

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/krystianslowik/skald/agent/internal/logparse"
	"github.com/krystianslowik/skald/agent/internal/restore"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/supervisor"
)

// Steps, in the order they run.
const (
	StepWait      = "wait"
	StepCountdown = "countdown"
	StepSave      = "save"
	StepStop      = "stop"
	StepBackup    = "backup"
	StepVerify    = "verify"
	StepStart     = "start"
	StepRecover   = "recover"
)

// StepNames lists every step in order.
var StepNames = []string{StepWait, StepCountdown, StepSave, StepStop, StepBackup, StepVerify, StepStart, StepRecover}

// Step states. Warn: the step did not do all it should, and the run went on
// (a save that did not report back, before a stop that saves anyway).
const (
	Pending   = "pending"
	Running   = "running"
	OK        = "ok"
	Skipped   = "skipped"
	Warn      = "warn"
	Failed    = "error"
	Cancelled = "cancelled"
)

// Run states.
const (
	RunActive    = "running"
	RunDone      = "done"
	RunFailed    = "failed"
	RunCancelled = "cancelled"
)

// Limits on a request.
const (
	MaxDeadlineMinutes = 24 * 60
	MaxWarnMinutes     = 30
)

// Prefix names the archives a run takes in restore.SkaldDir.
const Prefix = "pre-restart"

var archiveName = regexp.MustCompile(`^pre-restart-\d{8}-\d{6}\.zip$`)

// Errors a caller may answer with.
var (
	ErrActive   = errors.New("a safe restart is already running")
	ErrNotFound = errors.New("no safe restart is running")
	ErrTooLate  = errors.New("the restart is past the point where it can be cancelled")
)

// Request is what an admin asked for.
type Request struct {
	// WhenEmpty waits until nobody plays before anything else.
	WhenEmpty bool `json:"whenEmpty"`
	// DeadlineMinutes, with WhenEmpty, goes ahead anyway this long after the
	// start (with the countdown, so players are warned); 0 waits for good.
	DeadlineMinutes int `json:"deadlineMinutes"`
	// WarnMinutes is the countdown with players on; 0 restarts without one.
	WarnMinutes int `json:"warnMinutes"`
	// Locale of the in-game warnings: "en" or "pl".
	Locale string `json:"locale"`
}

// Validate checks the numbers and fills the default locale.
func (r *Request) Validate() error {
	if r.DeadlineMinutes < 0 || r.DeadlineMinutes > MaxDeadlineMinutes {
		return fmt.Errorf("deadlineMinutes must be 0..%d", MaxDeadlineMinutes)
	}
	if r.WarnMinutes < 0 || r.WarnMinutes > MaxWarnMinutes {
		return fmt.Errorf("warnMinutes must be 0..%d", MaxWarnMinutes)
	}
	if !r.WhenEmpty {
		r.DeadlineMinutes = 0
	}
	if _, ok := texts[r.Locale]; !ok {
		r.Locale = "en"
	}
	return nil
}

// Step is one step's state. Reason is a short machine code; Error the
// cause of a failure, never a path or a player name.
type Step struct {
	Name   string     `json:"name"`
	State  string     `json:"state"`
	At     *time.Time `json:"at,omitempty"`
	Reason string     `json:"reason,omitempty"`
	Error  string     `json:"error,omitempty"`
}

// View is a run as /state and the events show it.
type View struct {
	ID      string  `json:"id"`
	Actor   string  `json:"actor"`
	Request Request `json:"request"`
	State   string  `json:"state"`
	// Step is the step running now, or the last one that ran.
	Step      string     `json:"step"`
	Steps     []Step     `json:"steps"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`
	// Deadline: while waiting for an empty server, the run goes ahead here.
	Deadline *time.Time `json:"deadline,omitempty"`
	// RestartAt is the end of the countdown.
	RestartAt *time.Time `json:"restartAt,omitempty"`
	// Forced: the deadline came with players still on.
	Forced bool `json:"forced"`
	// Warned: warnings went out in game.
	Warned        bool   `json:"warned"`
	Archive       string `json:"archive,omitempty"`
	ArchiveBytes  int64  `json:"archiveBytes,omitempty"`
	ArchiveSHA256 string `json:"archiveSha256,omitempty"`
	// JoinCode is the code the game registered after the start (crossplay).
	JoinCode    string `json:"joinCode,omitempty"`
	CancelledBy string `json:"cancelledBy,omitempty"`
	Error       string `json:"error,omitempty"`
	// Warning is something to look at in a run that went through (the game
	// had to be signalled harder to stop).
	Warning string `json:"warning,omitempty"`
}

func (v *View) step(name string) *Step {
	for i := range v.Steps {
		if v.Steps[i].Name == name {
			return &v.Steps[i]
		}
	}
	return nil
}

func (v View) clone() View {
	v.Steps = append([]Step(nil), v.Steps...)
	return v
}

// Supervisor is the part of supervisord a run needs.
type Supervisor interface {
	GetAllProcessInfo(ctx context.Context) ([]supervisor.ProcessInfo, error)
	StopProcess(ctx context.Context, name string, wait bool) error
	StartProcess(ctx context.Context, name string, wait bool) error
}

// Bridge is the admin plugin, for the in-game warnings and the save.
type Bridge interface {
	// Available: the plugin answers and takes commands.
	Available(ctx context.Context) bool
	Broadcast(ctx context.Context, text, actor string) error
	Save(ctx context.Context, actor string) error
}

// Options configure the runner.
type Options struct {
	ConfigDir  string
	World      string
	Supervisor Supervisor
	// State is the log tracker's view: players, saves, world loaded, join code.
	State func() state.Snapshot
	// Bridge is nil without the plugin.
	Bridge Bridge
	// Crossplay says whether a join code is to be expected after the start.
	Crossplay func() bool
	// Lock takes the agent's action lock (false when busy); Unlock frees it.
	// The run holds it from the save to the start.
	Lock   func() bool
	Unlock func()
	// Restarting marks the stop..start window.
	Restarting func(bool)
	// Publish sends one step change; the view is a copy.
	Publish func(step, result string, v View)
	Logger  *slog.Logger
	Now     func() time.Time

	// Tick is how often waits look again; 1 s when zero.
	Tick time.Duration
	// EmptyFor is how long the server must stay empty; 60 s when zero.
	EmptyFor time.Duration
	// Minute is the unit of the request's minutes (tests shrink it).
	Minute time.Duration
	// LockWait bounds waiting for the action lock; 60 s when zero.
	LockWait time.Duration
	// SaveTimeout bounds waiting for the save line; 2 min when zero.
	SaveTimeout time.Duration
	// ActionTimeout bounds the stop and the start; 5 min when zero.
	ActionTimeout time.Duration
	// RecoverTimeout bounds waiting for the world and the join code; long
	// enough for the image to download a game update on start. 20 min when zero.
	RecoverTimeout time.Duration
	// Keep is how many pre-restart archives stay; 5 when zero.
	Keep int
	// ResumeWait bounds waiting for supervisord when the agent starts; the
	// agent sidecar starts before the game container. 5 min when zero.
	ResumeWait time.Duration
	// StartTries is how often the game's start is tried; 3 when zero.
	StartTries int
	// ShutdownTimedOut reports whether the image logged, since the given
	// time, that the game did not shut down in time and had to be signalled
	// harder; nil when unknown.
	ShutdownTimedOut func(since time.Time) bool
}

// Runner runs one safe restart at a time and keeps the last one.
type Runner struct {
	opt Options

	mu  sync.Mutex
	cur *View
	// cancel ends the wait or the countdown; cancellable is false from the
	// save on.
	cancel      context.CancelFunc
	cancellable bool
	cancelledBy string
	done        chan struct{}
	// down: the run stopped the game and has not started it again (run
	// goroutine only); downUpdater: it stopped the updater too.
	down, downUpdater bool
}

// marker records a stopped game on disk, so an agent that dies before the
// start can start it again when it comes back (Resume).
func (r *Runner) marker() string {
	return filepath.Join(r.opt.ConfigDir, restore.SkaldDir, ".safe-restart-down")
}

// markerData is what the marker holds.
type markerData struct {
	Run     string    `json:"run"`
	At      time.Time `json:"at"`
	Updater bool      `json:"updater"`
	// Reported: an agent that could not reach supervisord already told the owner.
	Reported bool `json:"reported,omitempty"`
}

// markDown writes (down) or clears the marker, synced to disk. A run that
// cannot write it does not stop the game.
func (r *Runner) markDown(down, updater bool) error {
	r.down, r.downUpdater = down, updater
	dir := filepath.Dir(r.marker())
	if !down {
		err := os.Remove(r.marker())
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		syncDir(dir)
		return err
	}
	id := ""
	if v := r.View(); v != nil {
		id = v.ID
	}
	body, _ := json.Marshal(markerData{Run: id, At: r.opt.Now().UTC(), Updater: updater})
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return writeSynced(r.marker(), body)
}

// touchMarker refreshes the marker's time while the game is down.
func (r *Runner) touchMarker() {
	if r.down {
		if err := r.markDown(true, r.downUpdater); err != nil {
			r.opt.Logger.Warn("safe restart: marker not refreshed", "err", err)
		}
	}
}

// writeSynced writes p through a synced temporary file and a rename, then
// syncs the directory, so the file is on disk when it returns.
func writeSynced(p string, body []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(p), ".safe-restart-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name) // no-op after the rename
	_, err = tmp.Write(body)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, p)
	}
	if err != nil {
		return err
	}
	syncDir(filepath.Dir(p))
	return nil
}

func syncDir(dir string) { restore.SyncDir(dir) }

// stopped are the supervisord states of a program that is not running and
// not on its way anywhere.
func stopped(st string) bool { return st == "STOPPED" || st == "EXITED" || st == "FATAL" }

// Resume runs once when the agent starts. It removes copies a run left half
// written and, if a run stopped the game and the agent died before the
// start, starts it again: only when supervisord shows the game stopped (and
// the updater too, if the run had stopped it). An updater that runs is the
// image in charge, and a marker older than any run could last is ignored.
// Either way the run is reported as failed.
func (r *Runner) Resume() {
	dir := filepath.Join(r.opt.ConfigDir, restore.SkaldDir)
	if tmps, _ := filepath.Glob(filepath.Join(dir, "."+Prefix+"-*.tmp")); len(tmps) > 0 {
		for _, t := range tmps {
			_ = os.Remove(t)
		}
		r.opt.Logger.Info("safe restart: removed half-written copies", "n", len(tmps))
	}
	raw, err := os.ReadFile(r.marker())
	if err != nil {
		return
	}
	var m markerData
	// clear removes the marker only while it is still this run's.
	clear := func(run string) {
		raw, err := os.ReadFile(r.marker())
		var now markerData
		if err != nil || (json.Unmarshal(raw, &now) == nil && now.Run != run) {
			return
		}
		if os.Remove(r.marker()) == nil {
			syncDir(dir)
		}
	}
	if json.Unmarshal(raw, &m) != nil || m.At.IsZero() {
		r.opt.Logger.Warn("safe restart: unreadable marker removed")
		if os.Remove(r.marker()) == nil {
			syncDir(dir)
		}
		return
	}
	// The run refreshes the marker at every step while the game is down, so
	// its age is how long the agent has been gone.
	if r.opt.Now().Sub(m.At) > 2*r.opt.ActionTimeout+r.opt.RecoverTimeout {
		r.opt.Logger.Warn("safe restart: stale marker removed", "run", m.Run)
		clear(m.Run)
		if !m.Reported {
			r.interrupted(m, "the agent was gone too long after stopping the game for a safe restart; check that the game runs")
		}
		return
	}
	// The agent may be up before supervisord is, and the game may still be
	// on its way down: wait for both to answer and settle.
	// At pod boot the image's bootstrap runs first (and starts the updater):
	// nothing is decided before it is done.
	var srv, upd string
	end := r.opt.Now().Add(r.opt.ResumeWait)
	answered, booting := false, false
	for {
		ps, ok := r.procStates()
		srv, upd = procState(ps, restore.ServerProgram), procState(ps, restore.UpdaterProgram)
		answered = answered || ok
		boot, has := ps[BootstrapProgram]
		// Done: exited or failed, or not there at all. STOPPED is not yet spawned.
		booting = ok && has && boot != "EXITED" && boot != "FATAL"
		if ok && !booting && settled(srv) && settled(upd) {
			break
		}
		if !r.opt.Now().Before(end) {
			if !answered {
				r.opt.Logger.Error("safe restart: supervisord did not answer; the game may still be stopped", "run", m.Run)
				// Kept for the next start; the owner hears about it once.
				if !m.Reported {
					m.Reported = true
					if body, err := json.Marshal(m); err == nil {
						_ = writeSynced(r.marker(), body)
					}
					r.interrupted(m, "the agent restarted during the safe restart and could not reach supervisord; check that the game runs")
				}
				return
			}
			break
		}
		time.Sleep(r.opt.Tick)
	}
	msg := "the agent restarted during the safe restart"
	switch {
	case booting:
		// The image is still setting up; it starts the updater, which starts the game.
		msg += "; the image was still starting up and was left to start the game"
		clear(m.Run)
	case upd == "RUNNING":
		// Whatever the run had done, a running updater is the image in charge.
		msg += "; the image's updater is running and in charge of the game"
		clear(m.Run)
	case srv == "RUNNING" && m.Updater && stopped(upd):
		// The agent died between pausing the updater and stopping the game.
		msg += "; the game was still running"
		if r.lockWait(context.Background()) {
			if r.startUpdater() {
				msg += " and the updater was started again"
			} else {
				msg += ", but the updater could not be started again: start valheim-updater by hand"
			}
			clear(m.Run)
			r.opt.Unlock()
		} else {
			msg += "; another action held the game, so the updater was not started again"
			clear(m.Run)
		}
	case !stopped(srv):
		msg += "; the game is " + strings.ToLower(srv)
		clear(m.Run)
	case m.Updater && !stopped(upd):
		msg += "; the updater is " + strings.ToLower(upd) + ", so the game was left alone"
		clear(m.Run)
	default:
		if !r.lockWait(context.Background()) {
			msg += "; another action held the game, so it was not started"
			clear(m.Run)
			break
		}
		err := r.startGame(m.Updater)
		// Cleared before the lock is let go: a new run may write its own marker then.
		clear(m.Run)
		r.opt.Unlock()
		if err != nil {
			r.opt.Logger.Error("safe restart: could not start the game again", "err", err)
			msg += "; starting the game again failed: " + scrub(err)
		} else {
			r.opt.Logger.Warn("safe restart: the agent restarted mid-run; the game was started again", "run", m.Run)
			msg += "; the game was started again"
		}
	}
	r.interrupted(m, msg)
}

// procState is one program's state from procStates, "UNKNOWN" when it is missing.
func procState(ps map[string]string, name string) string {
	if st, ok := ps[name]; ok {
		return st
	}
	return "UNKNOWN"
}

// settled: a supervisord state that is not on its way somewhere.
func settled(st string) bool { return st != "STOPPING" && st != "STARTING" && st != "BACKOFF" }

// interrupted reports a run the agent lost to a restart.
func (r *Runner) interrupted(m markerData, msg string) {
	now := r.opt.Now().UTC()
	v := View{ID: m.Run, Actor: "unknown", State: RunFailed, Step: StepStart, StartedAt: m.At, EndedAt: &now, Error: msg}
	for _, name := range StepNames {
		v.Steps = append(v.Steps, Step{Name: name, State: Pending})
	}
	v.step(StepStart).State, v.step(StepStart).Reason = Failed, "interrupted"
	r.mu.Lock()
	if r.cur == nil {
		c := v.clone()
		r.cur = &c
	}
	r.mu.Unlock()
	r.opt.Publish("end", RunFailed, v)
}

// BootstrapProgram is the image's one-shot setup at container start.
const BootstrapProgram = "valheim-bootstrap"

// procStates is every program's supervisord state.
func (r *Runner) procStates() (map[string]string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	infos, err := r.opt.Supervisor.GetAllProcessInfo(ctx)
	if err != nil {
		return map[string]string{}, false
	}
	out := map[string]string{}
	for _, p := range infos {
		out[p.Name] = p.StateName
	}
	return out, true
}

// states is the game's and the updater's states ("UNKNOWN" when missing).
func (r *Runner) states() (string, string, bool) {
	ps, ok := r.procStates()
	if !ok {
		return "", "", false
	}
	return procState(ps, restore.ServerProgram), procState(ps, restore.UpdaterProgram), true
}

// New returns a runner with defaults filled in.
func New(opt Options) *Runner {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Logger == nil {
		opt.Logger = slog.Default()
	}
	if opt.Tick == 0 {
		opt.Tick = time.Second
	}
	if opt.EmptyFor == 0 {
		opt.EmptyFor = 60 * time.Second
	}
	if opt.Minute == 0 {
		opt.Minute = time.Minute
	}
	if opt.LockWait == 0 {
		opt.LockWait = 60 * time.Second
	}
	if opt.SaveTimeout == 0 {
		opt.SaveTimeout = 2 * time.Minute
	}
	if opt.ActionTimeout == 0 {
		opt.ActionTimeout = 5 * time.Minute
	}
	if opt.RecoverTimeout == 0 {
		opt.RecoverTimeout = 20 * time.Minute
	}
	if opt.Keep == 0 {
		opt.Keep = 5
	}
	if opt.ResumeWait == 0 {
		opt.ResumeWait = 5 * time.Minute
	}
	if opt.StartTries == 0 {
		opt.StartTries = 3
	}
	if opt.Crossplay == nil {
		opt.Crossplay = func() bool { return false }
	}
	if opt.Lock == nil {
		opt.Lock = func() bool { return true }
	}
	if opt.Unlock == nil {
		opt.Unlock = func() {}
	}
	if opt.Restarting == nil {
		opt.Restarting = func(bool) {}
	}
	if opt.Publish == nil {
		opt.Publish = func(string, string, View) {}
	}
	return &Runner{opt: opt}
}

// Active reports a run in progress.
func (r *Runner) Active() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cur != nil && r.cur.State == RunActive
}

// View returns the current or last run; nil before the first.
func (r *Runner) View() *View {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cur == nil {
		return nil
	}
	v := r.cur.clone()
	return &v
}

// Wait blocks until the current run (if any) has ended. For tests.
func (r *Runner) Wait() {
	r.mu.Lock()
	done := r.done
	r.mu.Unlock()
	if done != nil {
		<-done
	}
}

// Writable reports why a run cannot start, or "" when it can.
func (r *Runner) Writable() string {
	if r.opt.World == "" {
		return "WORLD_NAME is not set"
	}
	if restore.Writable(r.opt.ConfigDir) != "" {
		return "the agent cannot write the config volume"
	}
	return ""
}

// Start validates req and starts a run in the background.
func (r *Runner) Start(req Request, actor string) (View, error) {
	if err := req.Validate(); err != nil {
		return View{}, err
	}
	if why := r.Writable(); why != "" {
		return View{}, errors.New(why)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cur != nil && r.cur.State == RunActive {
		return View{}, ErrActive
	}
	now := r.opt.Now().UTC()
	v := &View{
		ID:        now.Format("20060102-150405"),
		Actor:     actor,
		Request:   req,
		State:     RunActive,
		StartedAt: now,
	}
	for _, name := range StepNames {
		v.Steps = append(v.Steps, Step{Name: name, State: Pending})
	}
	if req.WhenEmpty && req.DeadlineMinutes > 0 {
		d := now.Add(time.Duration(req.DeadlineMinutes) * r.opt.Minute)
		v.Deadline = &d
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cur, r.cancel, r.cancellable, r.cancelledBy = v, cancel, true, ""
	r.done = make(chan struct{})
	go r.run(ctx, r.done)
	return v.clone(), nil
}

// Cancel ends a run that is still waiting or counting down.
func (r *Runner) Cancel(actor string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cur == nil || r.cur.State != RunActive {
		return ErrNotFound
	}
	if !r.cancellable {
		return ErrTooLate
	}
	r.cancelledBy = actor
	r.cancel()
	return nil
}

// set changes one step (and the run's current step) and publishes the run.
// An unknown step name is a bug; it is logged and ignored.
func (r *Runner) set(name, st, reason string, err error) {
	r.mu.Lock()
	v := r.cur
	var s *Step
	if v != nil {
		s = v.step(name)
	}
	if s == nil {
		r.mu.Unlock()
		r.opt.Logger.Error("safe restart: no such step", "step", name)
		return
	}
	now := r.opt.Now().UTC()
	s.State, s.Reason, s.At = st, reason, &now
	s.Error = ""
	if err != nil {
		s.Error = scrub(err)
	}
	v.Step = name
	snap := v.clone()
	r.mu.Unlock()
	r.opt.Publish(name, st, snap)
}

// update changes the run under the lock, without publishing.
func (r *Runner) update(fn func(v *View)) {
	r.mu.Lock()
	fn(r.cur)
	r.mu.Unlock()
}

// finish ends the run and publishes it once more, as its last step.
func (r *Runner) finish(state string, err error) {
	r.mu.Lock()
	v := r.cur
	now := r.opt.Now().UTC()
	v.State, v.EndedAt = state, &now
	if err != nil {
		v.Error = scrub(err)
	}
	if state == RunCancelled {
		v.CancelledBy = r.cancelledBy
	}
	r.cancellable = false
	r.cancel()
	snap := v.clone()
	r.mu.Unlock()
	r.opt.Publish("end", state, snap)
}

// Errors that end a run before the game is touched.
var (
	errNotRunning = errors.New("the game is not running")
	errMarker     = errors.New("cannot record the stop on disk")
)

func (r *Runner) run(ctx context.Context, done chan struct{}) {
	defer close(done)
	defer func() {
		if p := recover(); p != nil {
			r.opt.Logger.Error("safe restart panicked", "panic", p)
			// Never leave the game down.
			if r.down {
				if err := r.startGame(r.downUpdater); err == nil {
					_ = r.markDown(false, false)
				}
			}
			r.finish(RunFailed, fmt.Errorf("internal error"))
		}
	}()
	r.opt.Publish("begin", Running, *r.View())

	if err := r.waitEmpty(ctx); err != nil {
		if errors.Is(err, errNotRunning) {
			r.failEarly(StepWait, "notrunning", err)
		} else {
			r.cancelled(StepWait, false)
		}
		return
	}
	if err := r.countdown(ctx); err != nil {
		r.cancelled(StepCountdown, true)
		return
	}
	if ok := r.lockWait(ctx); !ok {
		if ctx.Err() != nil {
			r.cancelled(StepCountdown, true)
		} else {
			r.failEarly(StepSave, "busy", errors.New("another action is in progress"))
		}
		return
	}
	locked := true
	unlock := func() {
		if locked {
			locked = false
			r.opt.Unlock()
		}
	}
	defer unlock()

	// Only a running game is restarted: a stopped one may be the image's
	// updater at work, which must not be cut off.
	if st := r.serverState(); st != "RUNNING" {
		r.failEarly(StepSave, "notrunning", fmt.Errorf("the game is %s; try again when it is running", strings.ToLower(st)))
		return
	}

	r.save()

	// Last checks before the game is touched; a wait can last a day.
	if why := r.Writable(); why != "" {
		r.failEarly(StepStop, "readonly", errors.New(why))
		return
	}
	if err := r.room(); err != nil {
		r.failEarly(StepStop, "nospace", err)
		return
	}
	// The point of no return: a cancel that got in before this still counts.
	r.mu.Lock()
	r.cancellable = false
	late := ctx.Err() != nil
	r.mu.Unlock()
	if late {
		// The steps so far keep their results; the stop is what was called off.
		r.cancelled(StepStop, true)
		return
	}

	r.opt.Restarting(true)
	restarting := true
	endRestart := func() {
		if restarting {
			restarting = false
			r.opt.Restarting(false)
		}
	}
	defer endRestart()

	stopAt := r.opt.Now()
	updater, err := r.stop()
	switch {
	case errors.Is(err, errMarker):
		endRestart()
		r.failEarly(StepStop, "marker", err)
		return
	case errors.Is(err, errNotRunning):
		endRestart()
		r.failEarly(StepStop, "notrunning", err)
		return
	case err != nil:
		err = fmt.Errorf("stop: %w", err)
		r.set(StepStop, Failed, "", err)
		// The game may still run; make sure it does.
		r.set(StepStart, Running, "", nil)
		if serr := r.startGame(updater); serr != nil {
			serr = fmt.Errorf("start: %w", serr)
			r.set(StepStart, Failed, "", serr)
			err = errors.Join(err, serr)
		} else {
			r.clearMarker()
			r.set(StepStart, OK, "", nil)
		}
		endRestart()
		r.finish(RunFailed, err)
		return
	}
	r.set(StepStop, OK, "", nil)

	// The world is quiet now: back it up and read the copy back.
	r.touchMarker()
	var runErr error
	verified := false
	archive, digest, err := r.backup()
	if err != nil {
		runErr = fmt.Errorf("backup: %w", err)
		r.set(StepBackup, Failed, "", err)
		r.set(StepVerify, Skipped, "nobackup", nil)
	} else {
		r.update(func(v *View) { v.Archive = filepath.Base(archive); v.ArchiveSHA256 = digest })
		r.set(StepBackup, OK, "", nil)
		r.set(StepVerify, Running, "", nil)
		r.touchMarker()
		size, err := Verify(archive, digest, r.opt.World, countChunks(r.opt.ConfigDir, r.opt.World))
		if err != nil {
			runErr = fmt.Errorf("verify: %w", err)
			// Kept for a look, but out of the restore list and the count.
			if q, qerr := quarantine(archive); qerr == nil {
				r.update(func(v *View) { v.Archive = filepath.Base(q) })
			}
			r.pruneFailed()
			r.set(StepVerify, Failed, "", err)
		} else {
			verified = true
			r.update(func(v *View) { v.ArchiveBytes = size })
			r.set(StepVerify, OK, "", nil)
		}
	}

	// Looked at after the backup, so the image's log line has arrived.
	if r.opt.ShutdownTimedOut != nil && r.opt.ShutdownTimedOut(stopAt) {
		// The game did not stop on its own in time: its last save may be cut.
		r.update(func(v *View) {
			v.Warning = "the game did not shut down in time and was signalled harder; check the world"
		})
		r.set(StepStop, Warn, "killed", nil)
	}

	// Started either way: nothing has touched the world.
	r.touchMarker()
	r.set(StepStart, Running, "", nil)
	startedAt := r.opt.Now()
	if err := r.startGame(updater); err != nil {
		err = fmt.Errorf("start: %w", err)
		r.set(StepStart, Failed, "", err)
		endRestart()
		r.finish(RunFailed, errors.Join(runErr, err))
		return
	}
	r.clearMarker()
	endRestart()
	unlock()
	r.set(StepStart, OK, "", nil)

	if err := r.recoverGame(startedAt, r.opt.Now()); err != nil {
		runErr = errors.Join(runErr, err)
	}
	if verified {
		r.prune(archive)
	}
	if runErr != nil {
		r.finish(RunFailed, runErr)
		return
	}
	r.finish(RunDone, nil)
}

// clearMarker removes the marker once the game is started; a failure only
// leaves a marker Resume handles.
func (r *Runner) clearMarker() {
	if err := r.markDown(false, false); err != nil {
		r.opt.Logger.Warn("safe restart: marker not removed", "err", err)
	}
}

// failEarly ends a run that failed before the game was touched; warned
// players hear that the restart is off.
func (r *Runner) failEarly(step, reason string, err error) {
	r.set(step, Failed, reason, err)
	r.calledOff()
	r.finish(RunFailed, err)
}

// cancelled ends a run cancelled at step; warned players hear it.
func (r *Runner) cancelled(step string, announce bool) {
	r.set(step, Cancelled, "", nil)
	if announce {
		r.calledOff()
	}
	r.finish(RunCancelled, nil)
}

// calledOff tells players who were warned that the restart is off.
func (r *Runner) calledOff() {
	v := r.View()
	if !v.Warned || r.opt.Bridge == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := r.opt.Bridge.Broadcast(ctx, r.text("cancelled", 0), v.Actor); err != nil {
		r.opt.Logger.Warn("safe restart: called-off broadcast failed", "err", err)
	}
}

// worldBytes is the size of the world's files on disk.
func worldBytes(configDir, world string) int64 {
	var total int64
	base := filepath.Join(configDir, "worlds_local")
	for _, item := range restore.WorldItems(world) {
		_ = filepath.WalkDir(filepath.Join(base, item), func(_ string, d fs.DirEntry, err error) error {
			if err == nil && d.Type().IsRegular() {
				if fi, err := d.Info(); err == nil {
					total += fi.Size()
				}
			}
			return nil
		})
	}
	return total
}

// room checks that the copy fits: at least the world's size free where the
// copies go (a zip is smaller than the world, so this leaves a margin).
func (r *Runner) room() error {
	dir := filepath.Join(r.opt.ConfigDir, restore.SkaldDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	free, err := freeSpace(dir)
	if err != nil {
		return nil // cannot tell; the copy reports a full disk itself
	}
	if need := worldBytes(r.opt.ConfigDir, r.opt.World); free < uint64(need) {
		return fmt.Errorf("only %d MB free for a copy of a %d MB world", free>>20, need>>20)
	}
	return nil
}

// freeSpace is freeBytes; tests replace it.
var freeSpace = freeBytes

// countChunks is how many chunk files the world has on disk; -1 when unknown.
func countChunks(configDir, world string) int {
	m, err := filepath.Glob(filepath.Join(configDir, "worlds_local", world, "*.chunk"))
	if err != nil {
		return -1
	}
	return len(m)
}

// quarantine renames an archive that failed its check (and its .sha256) out
// of the names the restore list and the pruning look at.
func quarantine(archive string) (string, error) {
	q := filepath.Join(filepath.Dir(archive), "failed-"+filepath.Base(archive))
	if err := os.Rename(archive, q); err != nil {
		return "", err
	}
	_ = os.Rename(archive+".sha256", q+".sha256")
	return q, nil
}

// absPath is an absolute path in an error; only its last part is kept.
var absPath = regexp.MustCompile(`/(?:[^/\s:"']+/)+([^/\s:"']+)`)

// scrub is an error as a run shows it: no directories, nothing the log
// redaction would hide.
func scrub(err error) string {
	return logparse.Redact(absPath.ReplaceAllString(err.Error(), "$1"))
}

// players is who is on, and the server's status: running, stopped, or one
// on the way between (starting, stopping); unknown without a status file.
func (r *Runner) players() (int, string) {
	snap := r.opt.State()
	n := snap.PlayersReported
	if len(snap.Players) > n {
		n = len(snap.Players)
	}
	return n, snap.Status
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// waitEmpty waits for an empty server held EmptyFor, or for the deadline. A
// server on its way up or down is waited out: the players of a booting
// server are not in yet. It returns only ctx's error.
func (r *Runner) waitEmpty(ctx context.Context) error {
	v := r.View()
	if !v.Request.WhenEmpty {
		r.set(StepWait, Skipped, "now", nil)
		return nil
	}
	r.set(StepWait, Running, "", nil)
	var since time.Time
	for {
		n, status := r.players()
		now := r.opt.Now()
		settled := status == state.StatusRunning || status == state.StatusUnknown || status == "stopped"
		if n == 0 && settled {
			if since.IsZero() {
				since = now
			}
			if now.Sub(since) >= r.opt.EmptyFor {
				r.set(StepWait, OK, "empty", nil)
				return nil
			}
		} else if n == 0 {
			// Nobody on, but the game is on its way up or down.
			since = time.Time{}
			if v.Deadline != nil && !now.Before(*v.Deadline) {
				return fmt.Errorf("%w: it was %s at the deadline", errNotRunning, status)
			}
		} else {
			since = time.Time{}
			if v.Deadline != nil && !now.Before(*v.Deadline) {
				r.update(func(v *View) { v.Forced = true })
				r.set(StepWait, OK, "deadline", nil)
				return nil
			}
		}
		if err := sleep(ctx, r.opt.Tick); err != nil {
			return err
		}
	}
}

// marks are the remaining times a countdown of total warns at: the start,
// then 10, 5, 2 and 1 minutes and 30 and 10 seconds before the end.
func marks(total, minute time.Duration) []time.Duration {
	out := []time.Duration{total}
	for _, m := range []time.Duration{10 * minute, 5 * minute, 2 * minute, minute, minute / 2, minute / 6} {
		if m < total {
			out = append(out, m)
		}
	}
	return out
}

// countdown warns players on the server until the restart time. It ends
// early when the last one leaves. It returns only ctx's error.
func (r *Runner) countdown(ctx context.Context) error {
	v := r.View()
	n, _ := r.players()
	if v.Request.WarnMinutes == 0 {
		r.set(StepCountdown, Skipped, "none", nil)
		return nil
	}
	if n == 0 {
		r.set(StepCountdown, Skipped, "empty", nil)
		return nil
	}
	total := time.Duration(v.Request.WarnMinutes) * r.opt.Minute
	end := r.opt.Now().Add(total).UTC()
	bridgeOK := r.opt.Bridge != nil && r.opt.Bridge.Available(ctx)
	r.update(func(v *View) { v.RestartAt = &end })
	reason := ""
	if !bridgeOK {
		reason = "nobridge"
	}
	r.set(StepCountdown, Running, reason, nil)
	pending := marks(total, r.opt.Minute)
	for {
		left := end.Sub(r.opt.Now())
		if left <= 0 {
			break
		}
		if n, _ := r.players(); n == 0 {
			r.set(StepCountdown, OK, "emptied", nil)
			return nil
		}
		// The largest mark not yet passed is due; smaller ones wait.
		for len(pending) > 0 && pending[0] >= left {
			mark := pending[0]
			pending = pending[1:]
			if len(pending) > 0 && pending[0] >= left {
				continue // fell behind: only the latest due mark is sent
			}
			if bridgeOK {
				if err := r.opt.Bridge.Broadcast(ctx, r.textFor(mark), v.Actor); err != nil {
					r.opt.Logger.Warn("safe restart: warning broadcast failed", "err", err)
				} else {
					r.update(func(v *View) { v.Warned = true })
				}
			}
		}
		wait := r.opt.Tick
		if left < wait {
			wait = left
		}
		if err := sleep(ctx, wait); err != nil {
			return err
		}
	}
	r.set(StepCountdown, OK, reason, nil)
	return nil
}

// textFor is the warning for a mark: minutes, or seconds under one.
func (r *Runner) textFor(mark time.Duration) string {
	if mark >= r.opt.Minute {
		return r.text("min", int((mark+r.opt.Minute/2)/r.opt.Minute))
	}
	secs := int(mark * 60 / r.opt.Minute)
	if secs < 1 {
		secs = 1
	}
	return r.text("sec", secs)
}

// lockWait takes the action lock, waiting a while for a short action to
// end. False when it is still busy or ctx ends first.
func (r *Runner) lockWait(ctx context.Context) bool {
	end := r.opt.Now().Add(r.opt.LockWait)
	for {
		if r.opt.Lock() {
			return true
		}
		if !r.opt.Now().Before(end) {
			return false
		}
		if sleep(ctx, r.opt.Tick) != nil {
			return false
		}
	}
}

// save asks the game to save and waits for the save line. Never fatal: the
// stop that follows saves too.
func (r *Runner) save() {
	if r.opt.Bridge == nil {
		r.set(StepSave, Skipped, "nobridge", nil)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.opt.SaveTimeout)
	defer cancel()
	if !r.opt.Bridge.Available(ctx) {
		r.set(StepSave, Skipped, "nobridge", nil)
		return
	}
	r.set(StepSave, Running, "", nil)
	v := r.View()
	if n, _ := r.players(); n > 0 {
		if err := r.opt.Bridge.Broadcast(ctx, r.text("now", 0), v.Actor); err != nil {
			r.opt.Logger.Warn("safe restart: last warning failed", "err", err)
		} else {
			// Told it goes down now: they hear it if it does not.
			r.update(func(v *View) { v.Warned = true })
		}
	}
	asked := r.opt.Now()
	if err := r.opt.Bridge.Save(ctx, v.Actor); err != nil {
		r.set(StepSave, Warn, "failed", err)
		return
	}
	for {
		if at := r.opt.State().LastSaveAt; at != nil && !at.Before(asked.Truncate(time.Second)) {
			r.set(StepSave, OK, "", nil)
			return
		}
		if err := sleep(ctx, r.opt.Tick); err != nil {
			r.set(StepSave, Warn, "nosave", nil)
			return
		}
	}
}

// stop stops the updater (it may start the game on its own), checks the
// game still runs, and stops it. It reports whether the updater ran, so the
// start can bring it back. errMarker and errNotRunning mean the game was not
// touched (an updater it stopped is started again).
func (r *Runner) stop() (bool, error) {
	r.set(StepStop, Running, "", nil)
	ctx, cancel := context.WithTimeout(context.Background(), r.opt.ActionTimeout)
	defer cancel()
	// The updater may have stopped the game for an update during the save:
	// then neither is touched.
	srv, upd, ok := r.states()
	if !ok {
		return false, fmt.Errorf("%w: supervisord did not answer", errNotRunning)
	}
	if srv != "RUNNING" {
		return false, fmt.Errorf("%w: it is %s", errNotRunning, strings.ToLower(srv))
	}
	updater := upd == "RUNNING"
	// From here the game may go down: an agent that dies now starts it again on
	// its return. Without that record on disk, the game is not touched.
	if err := r.markDown(true, updater); err != nil {
		r.down = false
		return false, fmt.Errorf("%w: %v", errMarker, err)
	}
	if updater {
		// It ran: start it again afterwards even if this stop fails.
		if err := r.opt.Supervisor.StopProcess(ctx, restore.UpdaterProgram, true); err != nil && !supervisor.IsFault(err, supervisor.FaultNotRunning) {
			return true, err
		}
	}
	// Or just before the updater was stopped itself.
	if st := r.serverState(); st != "RUNNING" {
		if updater {
			r.startUpdater()
		}
		r.clearMarker()
		return false, fmt.Errorf("%w: it is %s", errNotRunning, strings.ToLower(st))
	}
	if err := r.opt.Supervisor.StopProcess(ctx, restore.ServerProgram, true); err != nil && !supervisor.IsFault(err, supervisor.FaultNotRunning) {
		return updater, err
	}
	return updater, nil
}

// serverState is the game's supervisord state, or "UNKNOWN".
func (r *Runner) serverState() string {
	srv, _, ok := r.states()
	if !ok {
		return "UNKNOWN"
	}
	return srv
}

// startGame brings the game back. It first waits until the game is fully
// stopped (never starts one still stopping). With the updater, the updater
// is started and starts the game itself after its update check, as the image
// does on boot: a game update is then installed before the game comes up,
// and the join code a run posts is not rotated by an update right after.
// If the updater has not started the game within RecoverTimeout, the game is
// started directly. Starts are tried StartTries times with a growing pause.
func (r *Runner) startGame(updater bool) error {
	end := r.opt.Now().Add(r.opt.ActionTimeout)
	for {
		st := r.serverState()
		if st == "RUNNING" || st == "STARTING" {
			if updater {
				r.startUpdater()
			}
			return nil
		}
		if stopped(st) {
			break
		}
		if !r.opt.Now().Before(end) {
			return fmt.Errorf("the game is still %s", strings.ToLower(st))
		}
		time.Sleep(r.opt.Tick)
	}
	if updater && r.startUpdater() {
		end := r.opt.Now().Add(r.opt.RecoverTimeout)
		next := r.opt.Now().Add(time.Minute)
		for r.opt.Now().Before(end) {
			srv, upd, _ := r.states()
			if srv == "RUNNING" || srv == "STARTING" {
				return nil
			}
			// An updater that ended will not start the game.
			if stopped(upd) {
				break
			}
			if r.opt.Now().After(next) {
				r.touchMarker()
				next = r.opt.Now().Add(time.Minute)
			}
			time.Sleep(r.opt.Tick)
		}
		// An updater still running is busy with an install (a large update, a
		// mod merge). The game is neither started beside it nor is the install
		// cut off: the updater starts the game when it is done.
		if _, upd, _ := r.states(); !stopped(upd) {
			return errors.New("the updater is still busy (installing?); it starts the game when it is done")
		}
		// It ended without starting the game: start it directly. supervisord
		// restarts an updater that exited; starting it here would run its
		// update check against the game just started.
		r.opt.Logger.Warn("safe restart: the updater ended without starting the game; starting it directly")
	}
	return r.startDirect()
}

// startDirect starts the game through supervisord, StartTries times with a
// growing pause.
func (r *Runner) startDirect() error {
	var err error
	pause := r.opt.Tick
	for i := 0; i < r.opt.StartTries; i++ {
		if i > 0 {
			time.Sleep(pause)
			pause *= 2
		}
		ctx, cancel := context.WithTimeout(context.Background(), r.opt.ActionTimeout)
		err = r.opt.Supervisor.StartProcess(ctx, restore.ServerProgram, true)
		cancel()
		if err == nil || supervisor.IsFault(err, supervisor.FaultAlreadyStarted) {
			return nil
		}
		r.opt.Logger.Warn("safe restart: start failed", "try", i+1, "err", err)
	}
	return err
}

// startUpdater starts the image's updater; false when that failed.
func (r *Runner) startUpdater() bool {
	ctx, cancel := context.WithTimeout(context.Background(), r.opt.ActionTimeout)
	defer cancel()
	if err := r.opt.Supervisor.StartProcess(ctx, restore.UpdaterProgram, false); err != nil && !supervisor.IsFault(err, supervisor.FaultAlreadyStarted) {
		r.opt.Logger.Warn("safe restart: updater did not start again", "err", err)
		return false
	}
	return true
}

func (r *Runner) backup() (string, string, error) {
	r.set(StepBackup, Running, "", nil)
	return restore.Archive(r.opt.ConfigDir, r.opt.World, filepath.Join(r.opt.ConfigDir, restore.SkaldDir), Prefix, r.opt.Now())
}

// recoverGame waits (RecoverTimeout from now) for the world to load after
// startedAt and, with crossplay, for a join code registered after it.
func (r *Runner) recoverGame(startedAt, now time.Time) error {
	r.set(StepRecover, Running, "", nil)
	crossplay := r.opt.Crossplay()
	after := func(t *time.Time) bool { return t != nil && !t.Before(startedAt.Truncate(time.Second)) }
	end := now.Add(r.opt.RecoverTimeout)
	for {
		snap := r.opt.State()
		loaded := after(snap.WorldLoadedAt)
		joined := !crossplay || (after(snap.JoinCodeSeenAt) && snap.JoinCode != "")
		if loaded && joined {
			if crossplay {
				r.update(func(v *View) { v.JoinCode = snap.JoinCode })
			}
			r.set(StepRecover, OK, "", nil)
			return nil
		}
		if !r.opt.Now().Before(end) {
			reason, err := "world_not_loaded", errors.New("the world did not load in time")
			if loaded {
				reason, err = "join_code_missing", errors.New("no join code in time")
			}
			r.set(StepRecover, Failed, reason, err)
			return err
		}
		time.Sleep(r.opt.Tick)
	}
}

// prune keeps the newest Keep pre-restart archives, never keep itself.
func (r *Runner) prune(keep string) {
	dir := filepath.Join(r.opt.ConfigDir, restore.SkaldDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if archiveName.MatchString(e.Name()) && e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	// The names sort by their time.
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for i, name := range names {
		if i < r.opt.Keep || name == filepath.Base(keep) {
			continue
		}
		p := filepath.Join(dir, name)
		if err := os.Remove(p); err != nil {
			r.opt.Logger.Warn("safe restart: old archive not removed", "archive", name, "err", err)
			continue
		}
		_ = os.Remove(p + ".sha256")
	}
}

// failedName matches the copies that failed their check.
var failedName = regexp.MustCompile(`^failed-pre-restart-\d{8}-\d{6}\.zip$`)

// FailedKeep is how many copies that failed their check stay for a look.
const FailedKeep = 2

// pruneFailed keeps the newest FailedKeep failed copies.
func (r *Runner) pruneFailed() {
	dir := filepath.Join(r.opt.ConfigDir, restore.SkaldDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if failedName.MatchString(e.Name()) && e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for i, name := range names {
		if i < FailedKeep {
			continue
		}
		p := filepath.Join(dir, name)
		if os.Remove(p) == nil {
			_ = os.Remove(p + ".sha256")
		}
	}
}

// ---- verify -------------------------------------------------------------------

var generation = regexp.MustCompile(`^_main\.(\d+)\.(db2|fwl2|chunks|ok)$`)

// Verify reads an archive back: a regular non-empty file whose sha256 is
// digest (and matches the .sha256 file next to it), whose entries all read
// to the end (archive/zip checks each CRC there), and which holds a complete
// world. A 1.0 world is the newest finished generation's .db2, .fwl2 and
// .chunks index, all non-empty, and its chunk files: at least one, and when
// diskChunks is not negative, exactly as many as the world has on disk. It
// returns the archive's size.
func Verify(archive, digest, world string, diskChunks int) (int64, error) {
	fi, err := os.Lstat(archive)
	if err != nil {
		return 0, err
	}
	if !fi.Mode().IsRegular() || fi.Size() == 0 {
		return 0, errors.New("the archive is empty or not a file")
	}
	f, err := os.Open(archive)
	if err != nil {
		return 0, err
	}
	sum := sha256.New()
	n, err := io.Copy(sum, f)
	f.Close()
	if err != nil {
		return 0, err
	}
	if n != fi.Size() {
		return 0, errors.New("the archive changed while it was read")
	}
	got := hex.EncodeToString(sum.Sum(nil))
	if got != digest {
		return 0, errors.New("checksum mismatch")
	}
	side, err := os.ReadFile(archive + ".sha256")
	if err != nil || !strings.HasPrefix(string(side), digest+" ") {
		return 0, errors.New("the checksum file is missing or differs")
	}
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return 0, err
	}
	defer zr.Close()
	type pair struct{ db, fwl, chunks, ok bool }
	chunkFiles := 0
	gens := map[int]*pair{}
	var flatDB, flatFWL bool
	prefix := "worlds_local/" + world + "/"
	for _, zf := range zr.File {
		rc, err := zf.Open()
		if err != nil {
			return 0, err
		}
		_, err = io.Copy(io.Discard, rc)
		rc.Close()
		if err != nil {
			return 0, fmt.Errorf("entry %s: %w", path.Base(zf.Name), err)
		}
		nonEmpty := zf.UncompressedSize64 > 0
		switch {
		case zf.Name == "worlds_local/"+world+".db":
			flatDB = nonEmpty
		case zf.Name == "worlds_local/"+world+".fwl":
			flatFWL = nonEmpty
		case strings.HasPrefix(zf.Name, prefix):
			rest := strings.TrimPrefix(zf.Name, prefix)
			if !strings.Contains(rest, "/") && strings.HasSuffix(rest, ".chunk") {
				chunkFiles++
				continue
			}
			m := generation.FindStringSubmatch(rest)
			if m == nil {
				continue
			}
			g, _ := strconv.Atoi(m[1])
			if gens[g] == nil {
				gens[g] = &pair{}
			}
			switch m[2] {
			case "db2":
				gens[g].db = nonEmpty
			case "fwl2":
				gens[g].fwl = nonEmpty
			case "chunks":
				gens[g].chunks = nonEmpty
			case "ok":
				gens[g].ok = true
			}
		}
	}
	// The newest save the game marked finished must be whole; without
	// markers, any whole generation will do.
	newestOK := -1
	anyWhole := false
	for g, p := range gens {
		if p.ok && g > newestOK {
			newestOK = g
		}
		if p.db && p.fwl && p.chunks {
			anyWhole = true
		}
	}
	switch {
	case newestOK >= 0:
		if p := gens[newestOK]; !p.db || !p.fwl || !p.chunks {
			return 0, fmt.Errorf("the newest finished save (%d) lacks its .db2, .fwl2 or .chunks", newestOK)
		}
	case anyWhole:
	case len(gens) == 0 && flatDB && flatFWL:
		return fi.Size(), nil // a pre-1.0 world has no chunk files
	default:
		return 0, errors.New("no complete world (.db2 + .fwl2 + .chunks, or .db + .fwl) in the archive")
	}
	if chunkFiles == 0 {
		return 0, errors.New("the archive holds no chunk files")
	}
	if diskChunks >= 0 && chunkFiles != diskChunks {
		return 0, fmt.Errorf("the archive holds %d chunk files, the world has %d", chunkFiles, diskChunks)
	}
	return fi.Size(), nil
}

// ---- in-game words -------------------------------------------------------------

var texts = map[string]map[string]string{
	"en": {
		"min":       "The server restarts in %d min. Find a safe spot.",
		"sec":       "The server restarts in %d s.",
		"now":       "The server restarts now. Back in a few minutes.",
		"cancelled": "The server restart is called off.",
	},
	"pl": {
		"min":       "Restart serwera za %d min. Znajdźcie bezpieczne miejsce.",
		"sec":       "Restart serwera za %d s.",
		"now":       "Restart serwera teraz. Wracamy za kilka minut.",
		"cancelled": "Restart serwera odwołany.",
	},
}

func (r *Runner) text(key string, n int) string {
	t := texts[r.View().Request.Locale][key]
	if strings.Contains(t, "%d") {
		return fmt.Sprintf(t, n)
	}
	return t
}
