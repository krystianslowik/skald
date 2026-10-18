package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/krystianslowik/skald/agent/internal/compat"
	"github.com/krystianslowik/skald/agent/internal/files"
	"github.com/krystianslowik/skald/agent/internal/icons"
	"github.com/krystianslowik/skald/agent/internal/settings"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/terrain"
	"github.com/krystianslowik/skald/agent/internal/world"
)

const serverProgram = "valheim-server"

type stateResponse struct {
	Now     time.Time      `json:"now"`
	Server  serverState    `json:"server"`
	Players []state.Player `json:"players"`
	World   worldState     `json:"world"`
	Backups []files.Backup `json:"backups"`
	Agent   agentState     `json:"agent"`
	// Settings is null when the settings feature is off.
	Settings *settings.Summary `json:"settings"`
	// Icons is null when ICONS_DIR is not set.
	Icons *icons.Info `json:"icons"`
	// Terrain is null without TERRAIN_DIR and a readable save; its request
	// says what a terrain run must sample for this world.
	Terrain *terrain.Info `json:"terrain"`
	// Compat is the last compatibility check with the game build; null
	// without a checker.
	Compat *compat.View `json:"compat"`
}

type serverState struct {
	Name            string            `json:"name"`
	World           string            `json:"world"`
	Args            string            `json:"args"`
	Status          string            `json:"status"`
	Processes       map[string]string `json:"processes"`
	ServerStartedAt *time.Time        `json:"serverStartedAt"`
	Version         string            `json:"version"`
	NetworkVersion  int               `json:"networkVersion"`
	JoinCode        string            `json:"joinCode"`
	JoinCodeAt      *time.Time        `json:"joinCodeAt"`
	PlayersReported int               `json:"playersReported"`
	Playfab         string            `json:"playfab"`
	NetStats        *state.NetStats   `json:"netStats"`
}

type worldState struct {
	SizeBytes  int64       `json:"sizeBytes"`
	LastSaveAt *time.Time  `json:"lastSaveAt"`
	LastSaveMs float64     `json:"lastSaveMs"`
	Meta       *world.Meta `json:"meta"`
	// Clock is null when the save is not readable.
	Clock *worldClock `json:"clock"`
}

type agentState struct {
	StartedAt time.Time  `json:"startedAt"`
	LastLogAt *time.Time `json:"lastLogAt"`
	// Version is the Skald release of this agent ("dev" for local builds).
	Version string `json:"version"`
}

func (s *Server) stateHandler(w http.ResponseWriter, r *http.Request) {
	snap := s.opt.Tracker.Snapshot()

	// Supervisor down is not an error for /state: processes stays empty and
	// the rest still renders.
	ps := s.fetchProcesses(r.Context())

	size, dbMtime := files.WorldSize(s.opt.ConfigDir, s.opt.WorldName)
	lastSave := snap.LastSaveAt
	if lastSave == nil {
		lastSave = dbMtime
	}

	name, args := s.opt.ServerName, s.opt.ServerArgs
	var sum *settings.Summary
	if st := s.opt.Settings; st != nil {
		// What the running server was started with, not what waits for a restart.
		eff := st.EffectiveSettings(ps.serverStart)
		name, args = eff.Name, eff.Args
		v := st.Summary(ps.serverStart)
		sum = &v
	}

	meta := s.world.Meta()
	now := time.Now().UTC()
	resp := stateResponse{
		Now: now,
		Server: serverState{
			Name:            name,
			World:           s.opt.WorldName,
			Args:            args,
			Status:          snap.Status,
			Processes:       ps.procs,
			ServerStartedAt: ps.startedAt,
			Version:         snap.Version,
			NetworkVersion:  snap.NetworkVersion,
			JoinCode:        snap.JoinCode,
			JoinCodeAt:      snap.JoinCodeAt,
			PlayersReported: snap.PlayersReported,
			Playfab:         snap.Playfab,
			NetStats:        snap.NetStats,
		},
		Players:  snap.Players,
		World:    worldState{SizeBytes: size, LastSaveAt: lastSave, LastSaveMs: snap.LastSaveMs, Meta: meta, Clock: s.clock(meta, snap.Players, now)},
		Backups:  files.Backups(s.opt.ConfigDir),
		Agent:    agentState{StartedAt: s.startedAt, LastLogAt: snap.LastLogAt, Version: s.opt.Version},
		Settings: sum,
		Icons:    s.opt.Icons.Info(),
		Terrain:  terrainInfo(s.opt.Terrain),
		Compat:   s.compatView(),
	}
	writeJSON(w, http.StatusOK, resp)
}

// procSnapshot is one getAllProcessInfo result. procs is never nil.
type procSnapshot struct {
	at        time.Time
	ok        bool
	procs     map[string]string
	startedAt *time.Time
	// serverStart is when supervisord last spawned valheim-server, also while
	// it is still STARTING: the pre-run hook has read the settings by then.
	serverStart *time.Time
}

// fetchProcesses asks supervisord for every process and caches the result
// for /metrics.
func (s *Server) fetchProcesses(ctx context.Context) procSnapshot {
	ps := procSnapshot{at: time.Now(), procs: map[string]string{}}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if infos, err := s.opt.Supervisor.GetAllProcessInfo(ctx); err != nil {
		s.opt.Logger.Warn("supervisor getAllProcessInfo", "err", err)
	} else {
		ps.ok = true
		for _, p := range infos {
			ps.procs[p.Name] = p.StateName
			if p.Name == serverProgram && p.Start > 0 && (p.StateName == "RUNNING" || p.StateName == "STARTING") {
				t := time.Unix(p.Start, 0).UTC()
				ps.serverStart = &t
				if p.StateName == "RUNNING" {
					ps.startedAt = &t
				}
			}
		}
	}
	s.procMu.Lock()
	s.procs = ps
	s.procMu.Unlock()
	return ps
}

// cachedProcesses returns the last supervisor result, re-fetching only when
// it is older than maxAge (or there is none yet).
func (s *Server) cachedProcesses(ctx context.Context, maxAge time.Duration) procSnapshot {
	s.procMu.Lock()
	ps := s.procs
	s.procMu.Unlock()
	if !ps.at.IsZero() && time.Since(ps.at) < maxAge {
		return ps
	}
	return s.fetchProcesses(ctx)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
