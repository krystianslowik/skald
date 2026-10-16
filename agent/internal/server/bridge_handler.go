package server

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/krystianslowik/skald/agent/internal/bridge"
)

// maxBridgeBody caps a command body; kits are the largest (20 lines).
const maxBridgeBody = 16 << 10

// bridgeStatus serves GET /bridge/status. While a restart is in flight the
// plugin is down with the game, and says so without being asked.
func (s *Server) bridgeStatus(w http.ResponseWriter, r *http.Request) {
	if s.restarting.Load() {
		writeJSON(w, http.StatusOK, bridge.Status{Reason: "restarting", TestedBuilds: []string{}, Commands: bridge.CommandNames()})
		return
	}
	writeJSON(w, http.StatusOK, s.opt.Bridge.Status(r.Context()))
}

// bridgePlayers serves GET /bridge/players: names, platform types,
// positions and health. Never a uid or a platform id.
func (s *Server) bridgePlayers(w http.ResponseWriter, r *http.Request) {
	players, err := s.opt.Bridge.Players(r.Context())
	if err != nil {
		bridgeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"players": players}})
}

// bridgeRead serves the allow-listed GETs: time, events, globalkeys,
// locations, and bans (by opaque id).
func (s *Server) bridgeRead(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var (
		data any
		err  error
	)
	if name == "bans" {
		data, err = s.opt.Bridge.Bans(r.Context())
	} else {
		data, err = s.opt.Bridge.Read(r.Context(), name)
	}
	if err != nil {
		bridgeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": data})
}

// bridgeCommand serves POST /bridge/{command} for the allow-list in
// internal/bridge. X-Skald-Actor names who ran it in the `admin` event and
// the plugin's audit line. Not serialised with restart/backup/update (the plugin queues its
// own work on the game's main thread), but refused while a restart runs.
func (s *Server) bridgeCommand(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("command")
	if _, ok := bridge.Commands[name]; !ok && name != "ack-build" {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown command " + name})
		return
	}
	if s.restarting.Load() {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "the server is restarting"})
		return
	}
	body := map[string]any{}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBridgeBody+1))
	if err != nil || len(raw) > maxBridgeBody {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"ok": false, "error": "body too large"})
		return
	}
	if len(raw) > 0 && json.Unmarshal(raw, &body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "body must be a JSON object"})
		return
	}
	actor := r.Header.Get("X-Skald-Actor")
	if name == "ack-build" {
		build, _ := body["build"].(string)
		if err := s.opt.Bridge.Acknowledge(r.Context(), build, actor); err != nil {
			bridgeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"build": build}})
		return
	}
	data, err := s.opt.Bridge.Run(r.Context(), name, body, actor)
	if err != nil {
		bridgeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": data})
}

func bridgeError(w http.ResponseWriter, err error) {
	msg := "bridge unavailable"
	if e, ok := err.(*bridge.Error); ok {
		msg = e.Message
	}
	writeJSON(w, bridge.StatusOf(err), map[string]any{"ok": false, "error": msg})
}
