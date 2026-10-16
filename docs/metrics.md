# Metrics and alerts

The agent serves the Prometheus text format on `:9464/metrics`:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `skald_build_info` | gauge | `component`, `version` | Always 1; `component="agent"` and the Skald release it was built from (`dev` for local builds) |
| `valheim_server_up` | gauge | | 1 when the status file says `running` |
| `valheim_server_status` | gauge | `status` | Current status file value (only the current one is emitted) |
| `valheim_server_started_timestamp_seconds` | gauge | | When supervisord started the server process |
| `valheim_supervisor_up` | gauge | | 1 when the last XML-RPC call succeeded |
| `valheim_process_running` | gauge | `process` | 1 per supervisord program in `RUNNING` |
| `valheim_players_online` | gauge | | Player count reported by the server |
| `valheim_playfab_state` | gauge | `state` | `ok`, `connecting` or `error` (current only) |
| `valheim_join_code_changed_timestamp_seconds` | gauge | | When the join code last changed |
| `valheim_info` | gauge | `version`, `network_version`, `world`, `server_name` | Always 1; facts as labels |
| `valheim_world_size_bytes` | gauge | | Size of the world save files |
| `valheim_world_net_time_seconds` | gauge | | World `netTime` from the newest save |
| `valheim_world_day` | gauge | | In-game day derived from `netTime` |
| `valheim_world_last_save_timestamp_seconds` | gauge | | Newest save seen (files or log) |
| `valheim_world_zdos` | gauge | | ZDO count from the periodic network line |
| `valheim_connections` | gauge | | Connection count from the same line |
| `valheim_backups_count` | gauge | | Number of `worlds-*.zip` backups |
| `valheim_backups_bytes` | gauge | | Their total size |
| `valheim_last_backup_timestamp_seconds` | gauge | | mtime of the newest backup |
| `valheim_events_total` | counter | `type` | Events since agent start: `player_join`, `player_leave`, `death`, `world_saved`, `world_backup`, `raid`, `join_code`, `action`, `settings_changed`, `settings_apply` |
| `valheim_settings_pending` | gauge | | 1 when server settings were saved after the server process started (a restart applies them). Only with server settings enabled |
| `valheim_agent_last_log_timestamp_seconds` | gauge | | Last log line the agent received |
| `valheim_map_build_seconds` | gauge | | How long the last world map build took. Only once a map was built |
| `valheim_map_generation` | gauge | | Save generation the world map was last built from |
| `valheim_terrain_tiles_total` | counter | `result` | Terrain tiles answered since agent start: `cache`, `bridge` (sampled by the bridge), `grid` (cut from the Job's grid), `derived` (downsampled from the level below), `error`, `dropped` (the viewer left or moved on before the bridge sampled it) |
| `valheim_terrain_bridge_sample_seconds_total` | counter | | Time the bridge plugin spent sampling terrain tiles (its own measurement, without rests) |
| `valheim_terrain_cache_bytes` | gauge | | Bytes of terrain tiles in the agent's cache |
| `valheim_terrain_bake_progress` | gauge | | Share of the current build's tile pyramid on disk, 0 to 1. Only while the bake is on and has started for a build |

skald-web has one metric, `skald_build_info{component="web",version="..."} 1`,
on a separate listener that is off unless `METRICS_BIND` is set (the
Kubernetes example uses `0.0.0.0:9465`). Like the agent's, it needs no
session, so keep that port to Prometheus; the panel port (`8080`) has no
`/metrics`. With both scraped, Prometheus can tell when the agent and the
panel run different releases:

```promql
count(count by (version) (skald_build_info)) > 1
```

[`deploy/kubernetes/servicemonitor.yaml`](../deploy/kubernetes/servicemonitor.yaml)
scrapes both.

[`deploy/monitoring`](../deploy/monitoring) has:

- **`prometheusrule.yaml`**: `ValheimMetricsAbsent`, `ValheimServerDown`,
  `ValheimPlayFabError`, `ValheimProcessNotRunning`, `ValheimBackupStale`. The
  `release:` label must match your kube-prometheus-stack `ruleSelector`.
- **`grafana-dashboard.json`**: import it in Grafana; it asks for your Prometheus
  and (optionally) Loki data sources and lets you change the agent job and
  namespace. For the Grafana sidecar, `kubectl apply -k deploy/monitoring`
  turns the same file into the `skald-dashboard` ConfigMap (labelled
  `grafana_dashboard: "1"`, namespace `monitoring`; change it in
  `kustomization.yaml` if your sidecar watches another one).
