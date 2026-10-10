# Metrics and alerts

The agent serves the Prometheus text format on `:9464/metrics`:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
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

[`deploy/monitoring`](../deploy/monitoring) has:

- **`prometheusrule.yaml`**: `ValheimMetricsAbsent`, `ValheimServerDown`,
  `ValheimPlayFabError`, `ValheimProcessNotRunning`, `ValheimBackupStale`. The
  `release:` label must match your kube-prometheus-stack `ruleSelector`.
- **`grafana-dashboard.json`**: import it in Grafana; it asks for your Prometheus
  and (optionally) Loki data sources and lets you change the agent job and
  namespace. **`grafana-dashboard-configmap.yaml`** is the same dashboard for the
  Grafana sidecar.
