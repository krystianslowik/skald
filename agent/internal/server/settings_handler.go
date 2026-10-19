package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/krystianslowik/skald/agent/internal/settings"
	"github.com/krystianslowik/skald/agent/internal/state"
)

const (
	// EmptyFor is how long the server must have had no players before an
	// apply-when-empty restarts it.
	EmptyFor = 60 * time.Second
	// settingsTick is how often the apply-when-empty watcher looks.
	settingsTick = 5 * time.Second
	// settingsProcMaxAge bounds the supervisor answer /settings reuses.
	settingsProcMaxAge = 5 * time.Second
)

type settingsError struct {
	OK      bool              `json:"ok"`
	Message string            `json:"message"`
	Errors  map[string]string `json:"errors,omitempty"`
}

func (s *Server) settingsView(ctx context.Context) settings.View {
	ps := s.cachedProcesses(ctx, settingsProcMaxAge)
	return s.opt.Settings.View(ps.serverStart)
}

func (s *Server) settingsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.settingsView(r.Context()))
}

// settingsPassword is its own call so the password only leaves the agent when
// someone asks to see it.
func (s *Server) settingsPassword(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	pw, ok := s.opt.Settings.Password()
	if !ok {
		writeJSON(w, http.StatusNotFound, settingsError{Message: "no password known"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"password": pw})
}

func (s *Server) settingsPut(w http.ResponseWriter, r *http.Request) {
	var in settings.Input
	dec := json.NewDecoder(io.LimitReader(r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, settingsError{Message: "bad request body"})
		return
	}
	changed, err := s.opt.Settings.Update(in)
	var verrs settings.Errors
	switch {
	case errors.As(err, &verrs):
		writeJSON(w, http.StatusBadRequest, settingsError{Message: "invalid settings", Errors: verrs})
		return
	case err != nil:
		// File errors carry paths, never values.
		s.opt.Logger.Warn("settings write failed", "err", err)
		writeJSON(w, http.StatusInternalServerError, settingsError{Message: "could not write the settings files"})
		return
	}
	if len(changed) > 0 {
		s.opt.Logger.Info("settings changed", "keys", changed)
		s.opt.Hub.Publish("settings_changed", map[string]any{"changedKeys": changed})
	}
	writeJSON(w, http.StatusOK, s.settingsView(r.Context()))
}

func (s *Server) settingsApply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, settingsError{Message: "bad request body"})
		return
	}
	switch body.Mode {
	case "now":
		if s.safeRestartActive() {
			writeJSON(w, http.StatusConflict, actionResult{false, "a safe restart is running"})
			return
		}
		if !s.busy.TryLock() {
			writeJSON(w, http.StatusConflict, actionResult{false, "another action is in progress"})
			return
		}
		if _, err := s.opt.Settings.Disarm(); err != nil {
			s.opt.Logger.Warn("settings disarm failed", "err", err)
		}
		s.startApply("now")
		writeJSON(w, http.StatusOK, actionResult{true, "restart started"})
	case "when_empty":
		if !s.opt.Settings.Pending(s.cachedProcesses(r.Context(), settingsProcMaxAge).serverStart) {
			writeJSON(w, http.StatusConflict, settingsError{Message: "nothing to apply"})
			return
		}
		was := s.opt.Settings.Armed()
		since, err := s.opt.Settings.Arm()
		if err != nil {
			s.opt.Logger.Warn("settings arm failed", "err", err)
			writeJSON(w, http.StatusInternalServerError, settingsError{Message: "could not write the settings files"})
			return
		}
		if !was {
			s.opt.Hub.Publish("settings_apply", map[string]any{"state": "armed", "mode": "when_empty", "since": since})
		}
		writeJSON(w, http.StatusOK, s.settingsView(r.Context()))
	default:
		writeJSON(w, http.StatusBadRequest, settingsError{Message: `mode must be "now" or "when_empty"`})
	}
}

func (s *Server) settingsCancel(w http.ResponseWriter, r *http.Request) {
	was, err := s.opt.Settings.Disarm()
	if err != nil {
		s.opt.Logger.Warn("settings disarm failed", "err", err)
		writeJSON(w, http.StatusInternalServerError, settingsError{Message: "could not write the settings files"})
		return
	}
	if was {
		s.opt.Hub.Publish("settings_apply", map[string]any{"state": "cancelled", "mode": "when_empty"})
	}
	writeJSON(w, http.StatusOK, s.settingsView(r.Context()))
}

// startApply restarts the server to pick up the settings. The caller holds
// s.busy; the restart releases it.
func (s *Server) startApply(mode string) {
	s.opt.Hub.Publish("settings_apply", map[string]any{"state": "applying", "mode": mode})
	s.publishAction("restart", true, "restart started")
	go s.restart(func(ok bool, msg string) {
		if ok {
			s.opt.Hub.Publish("settings_apply", map[string]any{"state": "applied", "mode": mode})
		} else {
			s.opt.Hub.Publish("settings_apply", map[string]any{"state": "failed", "mode": mode, "message": msg})
		}
	})
}

// RunSettingsWatcher drives apply-when-empty until ctx ends. No-op when the
// settings feature is off.
func (s *Server) RunSettingsWatcher(ctx context.Context) {
	if s.opt.Settings == nil {
		return
	}
	t := time.NewTicker(settingsTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			s.applyTick(ctx, now)
		}
	}
}

// applyTick is one look of the watcher: once an armed apply sees a running
// server with nobody on it for EmptyFor, it restarts. A busy action lock
// means "try again next tick", not "give up".
func (s *Server) applyTick(ctx context.Context, now time.Time) {
	st := s.opt.Settings
	if !st.Armed() {
		s.zeroSince = time.Time{}
		return
	}
	// The process snapshot may be a few seconds old, so a tick right after
	// someone else's restart can still see "pending"; the next one corrects it.
	if !st.Pending(s.cachedProcesses(ctx, settingsProcMaxAge).serverStart) {
		// Applied some other way (a pod restart, the restart rune).
		if was, _ := st.Disarm(); was {
			s.opt.Hub.Publish("settings_apply", map[string]any{"state": "applied", "mode": "when_empty"})
		}
		s.zeroSince = time.Time{}
		return
	}
	snap := s.opt.Tracker.Snapshot()
	if snap.Status != state.StatusRunning || snap.PlayersReported > 0 {
		s.zeroSince = time.Time{}
		return
	}
	if s.zeroSince.IsZero() {
		s.zeroSince = now
		return
	}
	if now.Sub(s.zeroSince) < EmptyFor {
		return
	}
	// A safe restart owns the game; its restart applies the settings too.
	if s.safeRestartActive() {
		return
	}
	if !s.busy.TryLock() {
		return
	}
	s.zeroSince = time.Time{}
	if _, err := st.Disarm(); err != nil {
		s.opt.Logger.Warn("settings disarm failed", "err", err)
	}
	s.startApply("when_empty")
}
