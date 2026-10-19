package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/saferestart"
)

// The safe restart runs here in the agent, not in skald-web: the agent holds
// the action lock, supervisord, the log tracker and the bridge, and it goes
// on running when skald-web restarts. Progress is `restart_run` events.

// newSafeRestart builds the runner on the server's own lock and flags.
func (s *Server) newSafeRestart() *saferestart.Runner {
	var br saferestart.Bridge
	if s.opt.Bridge != nil {
		br = runBridge{s.opt.Bridge}
	}
	return saferestart.New(saferestart.Options{
		ConfigDir:  s.opt.ConfigDir,
		World:      s.opt.WorldName,
		Supervisor: s.opt.Supervisor,
		State:      s.opt.Tracker.Snapshot,
		Bridge:     br,
		Crossplay:  s.opt.Crossplay,
		Lock:       s.busy.TryLock,
		Unlock:     s.busy.Unlock,
		Restarting: s.restarting.Store,
		Publish: func(step, result string, v saferestart.View) {
			s.opt.Hub.Publish("restart_run", map[string]any{"step": step, "result": result, "actor": v.Actor, "run": v})
		},
		Logger:           s.opt.Logger,
		ActionTimeout:    s.opt.ActionTimeout,
		RecoverTimeout:   s.opt.RecoverTimeout,
		ShutdownTimedOut: s.shutdownTimedOut,
	})
}

// shutdownLine is the image's valheim-server script giving up on a graceful
// stop ("Timeout while waiting for server to shut down - sending SIGTERM ...").
const shutdownLine = "Timeout while waiting for server to shut down"

// shutdownTimedOut looks for that line in the log since a time.
func (s *Server) shutdownTimedOut(since time.Time) bool {
	for _, l := range s.opt.Hub.Logs(2000) {
		if !l.TS.Before(since) && strings.Contains(l.Line, shutdownLine) {
			return true
		}
	}
	return false
}

// runBridge is the plugin as the run uses it. Its commands are audited like
// an admin's, under the admin who started the run.
type runBridge struct{ c *bridge.Client }

func (b runBridge) Available(ctx context.Context) bool { return b.c.Status(ctx).Available }

func (b runBridge) Broadcast(ctx context.Context, text, actor string) error {
	_, err := b.c.Run(ctx, "broadcast", map[string]any{"text": text, "type": "center"}, actor)
	return err
}

func (b runBridge) Save(ctx context.Context, actor string) error {
	_, err := b.c.Run(ctx, "save", nil, actor)
	return err
}

// ResumeSafeRestart starts the game again if a safe restart stopped it and
// the agent died before the start. Call once at startup.
func (s *Server) ResumeSafeRestart() { s.safe.Resume() }

// safeRestartActive: a run is waiting, counting down or restarting. Plain
// restarts, restores and settings applies are refused meanwhile.
func (s *Server) safeRestartActive() bool { return s.safe != nil && s.safe.Active() }

// safeRestartGet serves GET /restart/safe: the current or last run (null
// before the first) and why one cannot start ("" when it can).
func (s *Server) safeRestartGet(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"run": s.safe.View(), "reason": s.safe.Writable()}})
}

// safeRestartPost serves POST /restart/safe {whenEmpty, deadlineMinutes,
// warnMinutes, locale}: 202 with the run, 400 for a bad request, 409 while
// another run, a restore or another action holds the game.
func (s *Server) safeRestartPost(w http.ResponseWriter, r *http.Request) {
	var req saferestart.Request
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "body must be a JSON object"})
		return
	}
	if s.restoring.Load() || s.restarting.Load() {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "another action is in progress"})
		return
	}
	actor := bridge.CleanActor(r.Header.Get("X-Skald-Actor"))
	if actor == "" {
		actor = "unknown"
	}
	v, err := s.safe.Start(req, actor)
	switch {
	case errors.Is(err, saferestart.ErrActive):
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
	case err != nil:
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
	default:
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "data": v})
	}
}

// safeRestartDelete serves DELETE /restart/safe: cancels a run that is
// still waiting or counting down.
func (s *Server) safeRestartDelete(w http.ResponseWriter, r *http.Request) {
	actor := bridge.CleanActor(r.Header.Get("X-Skald-Actor"))
	if actor == "" {
		actor = "unknown"
	}
	err := s.safe.Cancel(actor)
	switch {
	case errors.Is(err, saferestart.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": err.Error()})
	case errors.Is(err, saferestart.ErrTooLate):
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
