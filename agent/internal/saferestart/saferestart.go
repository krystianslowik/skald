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
	"errors"
	"fmt"
	"io"
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

// Resume starts the game (and the updater) again if a run stopped them and
// the agent died before the start. Called once when the agent starts.
func (r *Runner) Resume() {
	raw, err := os.ReadFile(r.marker())
	if err != nil {
		return
	}
	updater := strings.TrimSpace(string(raw)) == "updater"
	r.opt.Logger.Warn("safe restart: the agent stopped mid-run; starting the game again")
	if err := r.startGame(updater); err != nil {
		r.opt.Logger.Error("safe restart: could not start the game again", "err", err)
		return
	}
	_ = os.Remove(r.marker())
}

// markDown writes or clears the marker.
func (r *Runner) markDown(down, updater bool) {
	r.down, r.downUpdater = down, updater
	if !down {
		_ = os.Remove(r.marker())
		return
	}
	body := ""
	if updater {
		body = "updater"
	}
	if err := os.MkdirAll(filepath.Dir(r.marker()), 0o755); err == nil {
		_ = os.WriteFile(r.marker(), []byte(body), 0o644)
	}
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
func (r *Runner) set(name, st, reason string, err error) {
	r.mu.Lock()
	v := r.cur
	s := v.step(name)
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

func (r *Runner) run(ctx context.Context, done chan struct{}) {
	defer close(done)
	defer func() {
		if p := recover(); p != nil {
			r.opt.Logger.Error("safe restart panicked", "panic", p)
			// Never leave the game down.
			if r.down {
				if err := r.startGame(r.downUpdater); err == nil {
					r.markDown(false, false)
				}
			}
			r.finish(RunFailed, fmt.Errorf("internal error"))
		}
	}()
	r.opt.Publish("begin", Running, *r.View())

	if err := r.waitEmpty(ctx); err != nil {
		r.cancelled(StepWait, false)
		return
	}
	if err := r.countdown(ctx); err != nil {
		r.cancelled(StepCountdown, true)
		return
	}
	// The point of no return: a cancel that got in before this still counts.
	r.mu.Lock()
	r.cancellable = false
	late := ctx.Err() != nil
	r.mu.Unlock()
	if late {
		r.cancelled(StepCountdown, true)
		return
	}

	if !r.lock() {
		err := errors.New("another action is in progress")
		r.set(StepSave, Failed, "busy", err)
		r.finish(RunFailed, err)
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
		err := fmt.Errorf("the game is %s; try again when it is running", strings.ToLower(st))
		r.set(StepSave, Failed, "notrunning", err)
		r.finish(RunFailed, err)
		return
	}

	r.save()

	r.opt.Restarting(true)
	restarting := true
	endRestart := func() {
		if restarting {
			restarting = false
			r.opt.Restarting(false)
		}
	}
	defer endRestart()

	updater, err := r.stop()
	if err != nil {
		err = fmt.Errorf("stop: %w", err)
		r.set(StepStop, Failed, "", err)
		// The game may still run; make sure it does.
		r.set(StepStart, Running, "", nil)
		if serr := r.startGame(updater); serr != nil {
			serr = fmt.Errorf("start: %w", serr)
			r.set(StepStart, Failed, "", serr)
			err = errors.Join(err, serr)
		} else {
			r.markDown(false, false)
			r.set(StepStart, OK, "", nil)
		}
		endRestart()
		r.finish(RunFailed, err)
		return
	}
	r.set(StepStop, OK, "", nil)

	// The world is quiet now: back it up and read the copy back.
	var runErr error
	archive, digest, err := r.backup()
	if err != nil {
		runErr = fmt.Errorf("backup: %w", err)
		r.set(StepBackup, Failed, "", err)
		r.set(StepVerify, Skipped, "nobackup", nil)
	} else {
		r.update(func(v *View) { v.Archive = filepath.Base(archive); v.ArchiveSHA256 = digest })
		r.set(StepBackup, OK, "", nil)
		r.set(StepVerify, Running, "", nil)
		size, err := Verify(archive, digest, r.opt.World)
		if err != nil {
			runErr = fmt.Errorf("verify: %w", err)
			r.set(StepVerify, Failed, "", err)
		} else {
			r.update(func(v *View) { v.ArchiveBytes = size })
			r.set(StepVerify, OK, "", nil)
		}
	}

	// Started either way: nothing has touched the world.
	r.set(StepStart, Running, "", nil)
	startedAt := r.opt.Now()
	if err := r.startGame(updater); err != nil {
		err = fmt.Errorf("start: %w", err)
		r.set(StepStart, Failed, "", err)
		endRestart()
		r.finish(RunFailed, errors.Join(runErr, err))
		return
	}
	r.markDown(false, false)
	endRestart()
	unlock()
	r.set(StepStart, OK, "", nil)

	if err := r.recoverGame(startedAt); err != nil {
		runErr = errors.Join(runErr, err)
	}
	if archive != "" {
		r.prune(archive)
	}
	if runErr != nil {
		r.finish(RunFailed, runErr)
		return
	}
	r.finish(RunDone, nil)
}

// cancelled ends a run cancelled at step; warned players hear it.
func (r *Runner) cancelled(step string, announce bool) {
	r.set(step, Cancelled, "", nil)
	if announce && r.View().Warned && r.opt.Bridge != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := r.opt.Bridge.Broadcast(ctx, r.text("cancelled", 0), r.View().Actor); err != nil {
			r.opt.Logger.Warn("safe restart: cancel broadcast failed", "err", err)
		}
		cancel()
	}
	r.finish(RunCancelled, nil)
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
			since = time.Time{}
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

// lock takes the action lock, waiting a while for a short action to end.
func (r *Runner) lock() bool {
	end := r.opt.Now().Add(r.opt.LockWait)
	for {
		if r.opt.Lock() {
			return true
		}
		if !r.opt.Now().Before(end) {
			return false
		}
		time.Sleep(r.opt.Tick)
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

// stop stops the updater (it may start the game on its own) and the game.
// It reports whether the updater ran, so start can bring it back.
func (r *Runner) stop() (bool, error) {
	r.set(StepStop, Running, "", nil)
	ctx, cancel := context.WithTimeout(context.Background(), r.opt.ActionTimeout)
	defer cancel()
	updater := r.processRunning(ctx, restore.UpdaterProgram)
	// From here the game may be down: an agent that dies now starts it again on its return.
	r.markDown(true, updater)
	if updater {
		// It ran: start it again afterwards even if this stop fails.
		if err := r.opt.Supervisor.StopProcess(ctx, restore.UpdaterProgram, true); err != nil && !supervisor.IsFault(err, supervisor.FaultNotRunning) {
			return true, err
		}
	}
	if err := r.opt.Supervisor.StopProcess(ctx, restore.ServerProgram, true); err != nil && !supervisor.IsFault(err, supervisor.FaultNotRunning) {
		return updater, err
	}
	return updater, nil
}

// serverState is the game's supervisord state, or "UNKNOWN".
func (r *Runner) serverState() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	infos, err := r.opt.Supervisor.GetAllProcessInfo(ctx)
	if err != nil {
		return "UNKNOWN"
	}
	for _, p := range infos {
		if p.Name == restore.ServerProgram {
			return p.StateName
		}
	}
	return "UNKNOWN"
}

func (r *Runner) processRunning(ctx context.Context, name string) bool {
	infos, err := r.opt.Supervisor.GetAllProcessInfo(ctx)
	if err != nil {
		return false
	}
	for _, p := range infos {
		if p.Name == name {
			return p.StateName == "RUNNING"
		}
	}
	return false
}

// startGame starts the game, then the updater if it was stopped.
func (r *Runner) startGame(updater bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), r.opt.ActionTimeout)
	defer cancel()
	if err := r.opt.Supervisor.StartProcess(ctx, restore.ServerProgram, true); err != nil && !supervisor.IsFault(err, supervisor.FaultAlreadyStarted) {
		return err
	}
	if updater {
		if err := r.opt.Supervisor.StartProcess(ctx, restore.UpdaterProgram, false); err != nil && !supervisor.IsFault(err, supervisor.FaultAlreadyStarted) {
			r.opt.Logger.Warn("safe restart: updater did not start again", "err", err)
		}
	}
	return nil
}

func (r *Runner) backup() (string, string, error) {
	r.set(StepBackup, Running, "", nil)
	return restore.Archive(r.opt.ConfigDir, r.opt.World, filepath.Join(r.opt.ConfigDir, restore.SkaldDir), Prefix, r.opt.Now())
}

// recoverGame waits for the world to load after startedAt and, with
// crossplay, for a join code registered after it.
func (r *Runner) recoverGame(startedAt time.Time) error {
	r.set(StepRecover, Running, "", nil)
	crossplay := r.opt.Crossplay()
	after := func(t *time.Time) bool { return t != nil && !t.Before(startedAt.Truncate(time.Second)) }
	end := startedAt.Add(r.opt.RecoverTimeout)
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

// ---- verify -------------------------------------------------------------------

var generation = regexp.MustCompile(`^_main\.(\d+)\.(db2|fwl2|ok)$`)

// Verify reads an archive back: a regular non-empty file whose sha256 is
// digest (and matches the .sha256 file next to it), whose entries all read
// to the end (archive/zip checks each CRC there), and which holds a complete
// world. It returns the archive's size.
func Verify(archive, digest, world string) (int64, error) {
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
	type pair struct{ db, fwl, ok bool }
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
			m := generation.FindStringSubmatch(strings.TrimPrefix(zf.Name, prefix))
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
		if p.db && p.fwl {
			anyWhole = true
		}
	}
	switch {
	case newestOK >= 0:
		if p := gens[newestOK]; !p.db || !p.fwl {
			return 0, fmt.Errorf("the newest finished save (%d) lacks its .db2 or .fwl2", newestOK)
		}
	case anyWhole:
	case flatDB && flatFWL:
	default:
		return 0, errors.New("no complete world (.db2 + .fwl2, or .db + .fwl) in the archive")
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
