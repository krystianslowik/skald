package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/compat"
)

// compatView is /state.compat; null without a checker.
func (s *Server) compatView() *compat.View {
	if s.opt.Compat == nil {
		return nil
	}
	v := s.opt.Compat.View()
	return &v
}

// EffectiveArgs is the SERVER_ARGS the running server started with: the
// saved settings it read at its start, else the environment's.
func (s *Server) EffectiveArgs(ctx context.Context) string {
	if st := s.opt.Settings; st != nil {
		return st.EffectiveSettings(s.cachedProcesses(ctx, metricsProcMaxAge).serverStart).Args
	}
	return s.opt.ServerArgs
}

// compatGet is GET /compat: the last compatibility check and whether one runs.
func (s *Server) compatGet(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.opt.Compat.View())
}

// compatRun is POST /compat/run: an admin asks for a check now. It answers at
// once; the result comes as a `compat` event.
func (s *Server) compatRun(w http.ResponseWriter, r *http.Request) {
	actor := bridge.CleanActor(r.Header.Get("X-Skald-Actor"))
	if err := s.opt.Compat.Start(); err != nil {
		if errors.Is(err, compat.ErrRunning) {
			writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "a check is running"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if actor == "" {
		actor = "unknown" // as the plugin's audit line names a caller without a name
	}
	s.opt.Hub.Publish("admin", map[string]any{"actor": actor, "command": "compat-check", "result": "ok", "via": "agent"})
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
}

// compatMetrics: one gauge per check with its current status, the overall
// status and when it was checked. Reason codes and numbers only.
func (s *Server) compatMetrics(p *promWriter) {
	v := s.compatView()
	if v == nil {
		return
	}
	p.family("skald_compat_running", "gauge", "1 while a compatibility check waits for the world or the map, else 0.")
	p.sample("skald_compat_running", boolf(v.Running))
	r := v.Result
	if r == nil {
		return
	}
	p.family("skald_compat_status", "gauge", "Overall status of the last compatibility check (ok, warn, fail); only the current status is emitted.")
	p.sample("skald_compat_status", 1, "status", r.Status, "build", r.Build)
	p.family("skald_compat_check_status", "gauge", "Status of each part of the last compatibility check (ok, warn, fail, pending, skipped); only the current status is emitted.")
	for _, ch := range r.Checks {
		p.sample("skald_compat_check_status", 1, "check", ch.Name, "status", ch.Status, "reason", ch.Reason)
	}
	p.family("skald_compat_checked_timestamp_seconds", "gauge", "Unix time the last compatibility check finished.")
	p.sample("skald_compat_checked_timestamp_seconds", unix(r.CheckedAt))
	if r.Updated && r.PreviousBuild != "" {
		p.family("skald_compat_updated_from_info", "gauge", "The game build the current one replaced; value is always 1.")
		p.sample("skald_compat_updated_from_info", 1, "build", r.Build, "previous", r.PreviousBuild)
	}
}
