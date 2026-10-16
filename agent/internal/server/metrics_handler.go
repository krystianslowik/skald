package server

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/krystianslowik/skald/agent/internal/files"
	"github.com/krystianslowik/skald/agent/internal/state"
	"github.com/krystianslowik/skald/agent/internal/world"
)

// metricsProcMaxAge bounds how stale the supervisor part of /metrics may be.
// /state refreshes the same cache; a scrape only calls supervisord itself
// when nothing else has in this window.
const metricsProcMaxAge = 30 * time.Second

// countedEvents are the event types exported as valheim_events_total.
var countedEvents = []string{"player_join", "player_leave", "death", "world_saved", "world_backup", "raid", "join_code", "action", "settings_changed", "settings_apply"}

// metricsHandler renders the Prometheus text exposition format (0.0.4) by
// hand from the same sources as /state.
func (s *Server) metricsHandler(w http.ResponseWriter, r *http.Request) {
	snap := s.opt.Tracker.Snapshot()
	ps := s.cachedProcesses(r.Context(), metricsProcMaxAge)
	size, dbMtime := files.WorldSize(s.opt.ConfigDir, s.opt.WorldName)
	meta := s.world.Meta()
	backups := files.Backups(s.opt.ConfigDir)

	var p promWriter

	p.family("skald_build_info", "gauge", "The Skald release this component was built from; value is always 1.")
	p.sample("skald_build_info", 1, "component", "agent", "version", s.opt.Version)

	p.family("valheim_server_up", "gauge", "1 if the server status file says running, else 0.")
	p.sample("valheim_server_up", boolf(snap.Status == state.StatusRunning))

	p.family("valheim_server_status", "gauge", "Current server status from the status file; only the current status is emitted.")
	p.sample("valheim_server_status", 1, "status", snap.Status)

	if ps.startedAt != nil {
		p.family("valheim_server_started_timestamp_seconds", "gauge", "Unix time the valheim-server process was started by supervisord.")
		p.sample("valheim_server_started_timestamp_seconds", unix(*ps.startedAt))
	}

	p.family("valheim_supervisor_up", "gauge", "1 if the last supervisord XML-RPC call succeeded, else 0.")
	p.sample("valheim_supervisor_up", boolf(ps.ok))

	if len(ps.procs) > 0 {
		names := make([]string, 0, len(ps.procs))
		for n := range ps.procs {
			names = append(names, n)
		}
		sort.Strings(names)
		p.family("valheim_process_running", "gauge", "1 if the supervisord process is RUNNING, else 0.")
		for _, n := range names {
			p.sample("valheim_process_running", boolf(ps.procs[n] == "RUNNING"), "process", n)
		}
	}

	p.family("valheim_players_online", "gauge", "Player count last reported by the server.")
	p.sample("valheim_players_online", float64(snap.PlayersReported))

	p.family("valheim_playfab_state", "gauge", "Current PlayFab connection state; only the current state is emitted.")
	p.sample("valheim_playfab_state", 1, "state", snap.Playfab)

	if snap.JoinCodeAt != nil {
		p.family("valheim_join_code_changed_timestamp_seconds", "gauge", "Unix time the join code last changed.")
		p.sample("valheim_join_code_changed_timestamp_seconds", unix(*snap.JoinCodeAt))
	}

	serverName := s.opt.ServerName
	if st := s.opt.Settings; st != nil {
		serverName = st.EffectiveSettings(ps.serverStart).Name
		p.family("valheim_settings_pending", "gauge", "1 if settings were saved after the server process started (a restart applies them), else 0.")
		p.sample("valheim_settings_pending", boolf(st.Pending(ps.serverStart)))
	}

	p.family("valheim_info", "gauge", "Static server facts as labels; value is always 1.")
	p.sample("valheim_info", 1,
		"version", snap.Version,
		"network_version", strconv.Itoa(snap.NetworkVersion),
		"world", s.opt.WorldName,
		"server_name", serverName)

	p.family("valheim_world_size_bytes", "gauge", "Size of the world save files in bytes.")
	p.sample("valheim_world_size_bytes", float64(size))

	if meta != nil {
		p.family("valheim_world_net_time_seconds", "gauge", "World netTime from the latest save, in seconds.")
		p.sample("valheim_world_net_time_seconds", meta.NetTime)
		p.family("valheim_world_day", "gauge", "Approximate in-game day derived from netTime.")
		p.sample("valheim_world_day", float64(meta.Day))
	}

	var lastSave *time.Time
	for _, t := range []*time.Time{snap.LastSaveAt, metaSavedAt(meta), dbMtime} {
		if t != nil && (lastSave == nil || t.After(*lastSave)) {
			lastSave = t
		}
	}
	if lastSave != nil {
		p.family("valheim_world_last_save_timestamp_seconds", "gauge", "Unix time of the newest world save seen (save files or World saved log line).")
		p.sample("valheim_world_last_save_timestamp_seconds", unix(*lastSave))
	}

	var backupBytes int64
	for _, b := range backups {
		backupBytes += b.SizeBytes
	}
	p.family("valheim_backups_count", "gauge", "Number of world backup zips.")
	p.sample("valheim_backups_count", float64(len(backups)))
	p.family("valheim_backups_bytes", "gauge", "Total size of world backup zips in bytes.")
	p.sample("valheim_backups_bytes", float64(backupBytes))
	if len(backups) > 0 {
		p.family("valheim_last_backup_timestamp_seconds", "gauge", "Unix mtime of the newest world backup zip.")
		p.sample("valheim_last_backup_timestamp_seconds", unix(backups[0].ModifiedAt))
	}

	if snap.NetStats != nil {
		p.family("valheim_world_zdos", "gauge", "ZDO count from the latest net stats line.")
		p.sample("valheim_world_zdos", float64(snap.NetStats.ZDOs))
		p.family("valheim_connections", "gauge", "Connection count from the latest net stats line.")
		p.sample("valheim_connections", float64(snap.NetStats.Connections))
	}

	p.family("valheim_events_total", "counter", "Notable events published since the agent started.")
	for _, typ := range countedEvents {
		p.sample("valheim_events_total", float64(s.opt.Hub.Count(typ)), "type", typ)
	}

	if enc := s.opt.Map.Current(); enc != nil {
		p.family("valheim_map_build_seconds", "gauge", "Duration of the last world map build, in seconds.")
		p.sample("valheim_map_build_seconds", s.opt.Map.LastBuildSeconds())
		p.family("valheim_map_generation", "gauge", "Save generation the world map was last built from.")
		p.sample("valheim_map_generation", float64(enc.Generation))
	}

	s.terrainTileMetrics(&p)

	if snap.LastLogAt != nil {
		p.family("valheim_agent_last_log_timestamp_seconds", "gauge", "Unix time the agent last received a log line.")
		p.sample("valheim_agent_last_log_timestamp_seconds", unix(*snap.LastLogAt))
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(p.b.String()))
}

func metaSavedAt(m *world.Meta) *time.Time {
	if m == nil {
		return nil
	}
	return &m.SavedAt
}

// promWriter builds the text exposition format. Callers emit one family()
// header and then its samples, without interleaving families.
type promWriter struct{ b strings.Builder }

func (p *promWriter) family(name, typ, help string) {
	p.b.WriteString("# HELP " + name + " " + helpEscaper.Replace(help) + "\n")
	p.b.WriteString("# TYPE " + name + " " + typ + "\n")
}

// sample writes one line; labels are key, value pairs.
func (p *promWriter) sample(name string, v float64, labels ...string) {
	p.b.WriteString(name)
	if len(labels) > 0 {
		p.b.WriteByte('{')
		for i := 0; i+1 < len(labels); i += 2 {
			if i > 0 {
				p.b.WriteByte(',')
			}
			p.b.WriteString(labels[i] + `="` + labelEscaper.Replace(labels[i+1]) + `"`)
		}
		p.b.WriteByte('}')
	}
	p.b.WriteString(" " + formatFloat(v) + "\n")
}

var (
	helpEscaper  = strings.NewReplacer(`\`, `\\`, "\n", `\n`)
	labelEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
)

func formatFloat(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func boolf(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func unix(t time.Time) float64 {
	return float64(t.UnixMilli()) / 1000
}
