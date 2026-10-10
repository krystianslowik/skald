package server

import (
	"context"
	"net/http"
	"time"

	"github.com/krystianslowik/skald/agent/internal/supervisor"
)

type actionResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// signalActions map an action to the supervisor program that gets SIGHUP.
// The community valheim-server image (formerly lloesche/valheim) runs backup
// and update checks on HUP.
var signalActions = map[string]string{
	"backup": "valheim-backup",
	"update": "valheim-updater",
}

// actionHandler runs one action at a time; a second request while one is in
// flight gets 409. backup/update hold the lock for the single signal call;
// restart holds it until the background stop+start has finished.
func (s *Server) actionHandler(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	program, isSignal := signalActions[name]
	if !isSignal && name != "restart" {
		writeJSON(w, http.StatusNotFound, actionResult{false, "unknown action " + name})
		return
	}
	if !s.busy.TryLock() {
		writeJSON(w, http.StatusConflict, actionResult{false, "another action is in progress"})
		return
	}

	if name == "restart" {
		s.publishAction(name, true, "restart started")
		go s.restart(nil)
		writeJSON(w, http.StatusOK, actionResult{true, "restart started"})
		return
	}

	defer s.busy.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := s.opt.Supervisor.SignalProcess(ctx, program, "HUP"); err != nil {
		s.opt.Logger.Warn("action failed", "action", name, "err", err)
		s.publishAction(name, false, err.Error())
		writeJSON(w, http.StatusBadGateway, actionResult{false, err.Error()})
		return
	}
	msg := "sent HUP to " + program
	s.publishAction(name, true, msg)
	writeJSON(w, http.StatusOK, actionResult{true, msg})
}

// restart stops then starts valheim-server, waiting for each. It runs
// detached from the request and owns s.busy until done. The lock is released
// before the result event goes out, so a client reacting to that event can
// immediately start the next action. after, if set, runs last.
func (s *Server) restart(after func(ok bool, msg string)) {
	ok, msg := s.stopStart()
	s.busy.Unlock()
	if !ok {
		s.opt.Logger.Warn("restart failed", "err", msg)
	}
	s.publishAction("restart", ok, msg)
	if after != nil {
		after(ok, msg)
	}
}

func (s *Server) stopStart() (bool, string) {
	stopCtx, stopCancel := context.WithTimeout(context.Background(), s.opt.ActionTimeout)
	err := s.opt.Supervisor.StopProcess(stopCtx, serverProgram, true)
	stopCancel()
	if err != nil && !supervisor.IsFault(err, supervisor.FaultNotRunning) {
		return false, "stop failed: " + err.Error()
	}

	startCtx, startCancel := context.WithTimeout(context.Background(), s.opt.ActionTimeout)
	err = s.opt.Supervisor.StartProcess(startCtx, serverProgram, true)
	startCancel()
	if err != nil && !supervisor.IsFault(err, supervisor.FaultAlreadyStarted) {
		return false, "start failed: " + err.Error()
	}
	return true, "restart complete"
}

func (s *Server) publishAction(name string, ok bool, msg string) {
	s.opt.Hub.Publish("action", map[string]any{"name": name, "ok": ok, "message": msg})
}
