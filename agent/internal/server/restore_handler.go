package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/logparse"
	"github.com/krystianslowik/skald/agent/internal/restore"
)

type restoreInfo struct {
	World string `json:"world"`
	// Reason is why a restore cannot run at all: "noworld", "readonly";
	// empty when it can.
	Reason        string           `json:"reason,omitempty"`
	Running       bool             `json:"running"`
	PlayersOnline bool             `json:"playersOnline"`
	Backups       []restore.Backup `json:"backups"`
}

func (s *Server) playersOnline() bool {
	snap := s.opt.Tracker.Snapshot()
	return snap.PlayersReported > 0 || len(snap.Players) > 0
}

func (s *Server) restoreOptions() restore.Options {
	return restore.Options{
		ConfigDir:     s.opt.ConfigDir,
		World:         s.opt.WorldName,
		Supervisor:    s.opt.Supervisor,
		PlayersOnline: s.playersOnline,
		Timeout:       s.opt.ActionTimeout,
		Logger:        s.opt.Logger,
	}
}

// restoreGet serves GET /restore: the backups a restore can use.
func (s *Server) restoreGet(w http.ResponseWriter, _ *http.Request) {
	info := restoreInfo{World: s.opt.WorldName, Running: s.restoring.Load(), PlayersOnline: s.playersOnline(), Backups: restore.List(s.opt.ConfigDir)}
	switch {
	case s.opt.WorldName == "":
		info.Reason = "noworld"
	case restore.Writable(s.opt.ConfigDir) != "":
		info.Reason = "readonly"
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": info})
}

// restorePost serves POST /restore {source, backup, confirm}: checks
// everything it can without touching the game, then runs the restore in the
// background, holding the action lock. Progress is `admin` events with
// command "restore".
func (s *Server) restorePost(w http.ResponseWriter, r *http.Request) {
	var req restore.Request
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &req) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "body must be a JSON object"})
		return
	}
	opt := s.restoreOptions()
	archive, err := restore.Validate(opt, req)
	if errors.Is(err, restore.ErrPlayersOnline) {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "players are online"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if s.safeRestartActive() {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "a safe restart is running"})
		return
	}
	if !s.busy.TryLock() {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "another action is in progress"})
		return
	}
	actor := bridge.CleanActor(r.Header.Get("X-Skald-Actor"))
	opt.Publish = func(step string, err error, extra map[string]any) {
		ev := map[string]any{"actor": actor, "command": "restore", "step": step, "result": "ok"}
		for k, v := range extra {
			ev[k] = v
		}
		if err != nil {
			ev["result"] = "error"
			ev["error"] = logparse.Redact(err.Error())
		}
		s.opt.Hub.Publish("admin", ev)
	}
	s.restoring.Store(true)
	s.restarting.Store(true)
	go func() {
		defer s.busy.Unlock()
		defer s.restoring.Store(false)
		defer s.restarting.Store(false)
		if err := restore.Run(context.Background(), opt, archive); err != nil {
			s.opt.Logger.Warn("restore failed", "backup", req.Backup, "err", err)
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "data": map[string]any{"backup": req.Backup}})
}
