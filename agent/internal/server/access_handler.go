package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/krystianslowik/skald/agent/internal/access"
	"github.com/krystianslowik/skald/agent/internal/bridge"
	"github.com/krystianslowik/skald/agent/internal/world"
)

// The admin and ban lists. These routes carry raw platform ids: the web tier
// serves them to admin sessions only, and the `admin` events they publish
// name players or mask the id.

type accessEntry struct {
	ID       string `json:"id"`
	Platform string `json:"platform"`
	Name     string `json:"name,omitempty"`
	// Known is false for a line in a format the agent does not recognise.
	Known bool `json:"known"`
}

type accessList struct {
	Entries []accessEntry `json:"entries"`
	// Live is true when a change applies to the running game at once (bans
	// through the bridge); otherwise it applies at the next start.
	Live bool `json:"live"`
}

type accessOnline struct {
	// ID is the player's id as /state lists it ("Ragnar#2").
	ID       string `json:"id"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Admin    bool   `json:"admin"`
	Banned   bool   `json:"banned"`
	// CanAdd: the agent knows this player's platform id.
	CanAdd bool `json:"canAdd"`
}

type accessResponse struct {
	Writable bool           `json:"writable"`
	Running  bool           `json:"running"`
	Admins   accessList     `json:"admins"`
	Bans     accessList     `json:"bans"`
	Online   []accessOnline `json:"online"`
}

// directory is what the agent knows about platform ids: names by id key, ids
// by lower-cased name.
type directory struct {
	names map[string]string
	ids   map[string]string
}

func (s *Server) directory(ctx context.Context) directory {
	d := directory{names: map[string]string{}, ids: map[string]string{}}
	if s.opt.WorldName != "" {
		if known, err := world.KnownPlayers(filepath.Join(s.opt.ConfigDir, "worlds_local", s.opt.WorldName)); err == nil {
			for _, p := range known {
				d.names[access.Key(p.ID)] = p.Name
				d.ids[strings.ToLower(p.Name)] = p.ID
			}
		}
	}
	if br := s.opt.Bridge; br != nil && !s.restarting.Load() {
		_, _ = br.Players(ctx) // refreshes the tables below; may fail with the game down
		for id, name := range br.Names() {
			d.names[access.Key(id)] = name
		}
		for name, id := range br.UserIDs() {
			d.ids[name] = id
		}
	}
	return d
}

func (d directory) entries(ids []string) []accessEntry {
	out := make([]accessEntry, 0, len(ids))
	for _, id := range ids {
		out = append(out, accessEntry{ID: id, Platform: access.Platform(id), Name: d.names[access.Key(id)], Known: access.ValidID(id)})
	}
	return out
}

// bansLive reports whether bans go through the bridge: the game runs and
// the plugin answers.
func (s *Server) bansLive(ctx context.Context) bool {
	return s.opt.Bridge != nil && !s.restarting.Load() && s.opt.Bridge.Status(ctx).Available
}

func (s *Server) readBans(ctx context.Context, live bool) ([]string, error) {
	if live {
		return s.opt.Bridge.BanEntries(ctx)
	}
	return s.opt.Access.Read(access.Bans)
}

func (s *Server) accessGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	admins, err := s.opt.Access.Read(access.Admins)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "cannot read adminlist.txt"})
		return
	}
	live := s.bansLive(ctx)
	bans, err := s.readBans(ctx, live)
	if err != nil {
		bridgeError(w, err)
		return
	}
	d := s.directory(ctx)
	resp := accessResponse{
		Writable: s.opt.Access.Writable(),
		Running:  s.fetchProcesses(ctx).procs[serverProgram] == "RUNNING",
		Admins:   accessList{Entries: d.entries(admins)},
		Bans:     accessList{Entries: d.entries(bans), Live: live},
		Online:   []accessOnline{},
	}
	onList := func(list []accessEntry, name, id string) bool {
		for _, e := range list {
			if (id != "" && access.Key(e.ID) == access.Key(id)) || (e.Name != "" && strings.EqualFold(e.Name, name)) {
				return true
			}
		}
		return false
	}
	for _, p := range s.opt.Tracker.Snapshot().Players {
		id := d.ids[strings.ToLower(p.Name)]
		resp.Online = append(resp.Online, accessOnline{
			ID:       p.ID,
			Name:     p.Name,
			Platform: p.Platform,
			Admin:    onList(resp.Admins.Entries, p.Name, id),
			Banned:   onList(resp.Bans.Entries, p.Name, id),
			CanAdd:   id != "",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": resp})
}

// accessChange serves POST /access/{list}/{op}: add or remove one entry.
// Body {"id": "..."} or, to add a player who is online, {"player": "name"}.
func (s *Server) accessChange(w http.ResponseWriter, r *http.Request) {
	list, op := r.PathValue("list"), r.PathValue("op")
	if _, ok := access.Files[list]; !ok || (op != "add" && op != "remove") {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "unknown list or operation"})
		return
	}
	if s.restarting.Load() {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "the server is restarting"})
		return
	}
	var body struct {
		ID     string `json:"id"`
		Player string `json:"player"`
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "body must be a JSON object"})
		return
	}
	ctx := r.Context()
	actor := bridge.CleanActor(r.Header.Get("X-Skald-Actor"))
	id, player := strings.TrimSpace(body.ID), strings.TrimSpace(body.Player)
	d := s.directory(ctx)
	if player != "" {
		if op != "add" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "remove takes an id"})
			return
		}
		id = d.ids[strings.ToLower(player)]
		if id == "" {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "no platform id known for " + player})
			return
		}
	}
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "missing id"})
		return
	}
	if op == "add" && !access.ValidID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": access.ErrBadID.Error()})
		return
	}
	name := d.names[access.Key(id)]

	// A running game keeps its ban list in memory and writes it back on the
	// next ban: change it through the bridge, whose client publishes the event.
	if list == access.Bans && s.bansLive(ctx) {
		if op == "add" {
			current, err := s.opt.Bridge.BanEntries(ctx)
			if err == nil {
				for _, e := range current {
					if access.Key(e) == access.Key(id) {
						writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": access.ErrExists.Error()})
						return
					}
				}
			}
			err = s.opt.Bridge.BanEntry(ctx, id, actor)
			if err != nil {
				bridgeError(w, err)
				return
			}
		} else if err := s.opt.Bridge.UnbanEntry(ctx, id, actor); err != nil {
			bridgeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"applies": "now"}})
		return
	}

	if !s.opt.Access.Writable() {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": "the agent cannot write the config volume"})
		return
	}
	if op == "add" {
		err = s.opt.Access.Add(list, id)
	} else {
		err = s.opt.Access.Remove(list, id)
	}
	command := map[string]string{"admins add": "admin-add", "admins remove": "admin-remove", "bans add": "ban", "bans remove": "unban"}[list+" "+op]
	switch {
	case errors.Is(err, access.ErrExists):
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
		return
	case errors.Is(err, access.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": err.Error()})
		return
	case errors.Is(err, access.ErrBadID):
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	case err != nil:
		s.opt.Logger.Warn("access list write failed", "list", list, "err", err)
		s.publishAccess(actor, command, name, id, "error", "could not write "+access.Files[list])
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "could not write " + access.Files[list]})
		return
	}
	applies := "restart"
	if s.fetchProcesses(ctx).procs[serverProgram] != "RUNNING" {
		applies = "start"
	}
	s.publishAccess(actor, command, name, id, "ok", "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": map[string]any{"applies": applies}})
}

// publishAccess audits one file change as an `admin` event: the player's name
// when known, else the platform and a masked id. Never the id itself.
func (s *Server) publishAccess(actor, command, name, id, result, errMsg string) {
	ev := map[string]any{"actor": actor, "command": command, "result": result, "via": "file", "platform": access.Platform(id)}
	if name != "" {
		ev["player"] = name
	} else {
		ev["masked"] = access.Mask(id)
	}
	if errMsg != "" {
		ev["error"] = errMsg
	}
	s.opt.Hub.Publish("admin", ev)
}
