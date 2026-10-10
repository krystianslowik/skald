# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-10

### Added

- Boss progress from the world save: the Progress strip lights defeated
  bosses and marks the next one. The agent reads the save's global keys
  (`world.meta.globalKeys`, `world.meta.bosses`) and falls back to "unknown"
  when the layout does not match.
- World modifiers from the save (`world.meta.modifiers`, `worldKeys`,
  `knownPlayers`), shown in the Forge. The settings form starts from them
  when nothing was saved yet, and otherwise preselects the ones the saved
  settings lack, with a note, so a save never drops them.
- A platform mark (controller or monitor) next to each player at the fire and
  in their profile, from the PlayFab platform line. Raw platform and PlayFab
  ids never leave the agent: they are redacted from the served log too.
- `world_backup` event for the game's own autobackup.

### Changed

- Joins, leaves, deaths, saves and the network summary use the line formats
  confirmed on a Valheim 1.0.17 crossplay session. Each player now leaves on
  their own (from the abandoned-object lines) instead of everyone at once when
  the count drops to zero, and reconnecting with another character leaves no
  ghost. Player counts come from the joined, lost and new-session lines.
- `world_saved` fires on the 1.0 `World save (5/5) done` line; the pre-1.0
  form still works.
- The in-game day is confirmed to match the game's own counter.

### Fixed

- The settings hook showed "ok" even when it never ran: the image echoes the
  hook command, which contains the confirmation text.

## [0.3.0] - 2026-10-10

### Added

- Server settings from the dashboard: name, password, public listing, world
  modifier presets and individual modifiers, world keys and save interval, in
  a sheet modelled on the game's World Modifiers screen. Only the launch
  options from Iron Gate's dedicated server guide are accepted; other
  `SERVER_ARGS` stay untouched and are shown read-only. Changes are validated
  as you type, saved optimistically, and applied with a restart now (press and
  hold) or once the server has been empty for a minute. A header chip shows
  pending and armed states.
- The server password next to the join code, masked until revealed.
- Agent: `/settings` API, `SETTINGS_DIR` and `PASSWORD_FILE`, the
  `valheim_settings_pending` metric and `settings_changed` / `settings_apply`
  events (never carrying the password).
- `deploy/settings/pre-server-run-hook.sh`: the game-side hook that reads the
  settings with an allow-list, with a bash test. Compose and Kubernetes
  examples wire it up.

## [0.2.0] - 2026-10-10

### Changed

- The dashboard now looks like Valheim's own UI: Averia Serif Libre (the game's
  UI font, OFL), wood boards with torn edges, inventory-style slots, blue
  selection, HUD-style meters, the join code as a centre-screen message, a boss
  trophy strip and a misty world backdrop. No game assets are used.
- The player profile is a draggable sheet (bottom on phones, side on desktop)
  with momentum, rubber-banding and velocity handoff.
- Press feedback on pointer-down and critically damped springs throughout.
- About 5x fewer re-renders per live message; the profile sheet is lazy-loaded.

### Fixed

- A 7 px sideways scroll on narrow phones.

## [0.1.0] - 2026-10-10

First public release.

### Added

- `skald-agent`: Go sidecar for the community Valheim server image. Receives the
  game's syslog, drives supervisord over XML-RPC, reads world save headers and
  backups; serves state, an SSE event stream with resume, the log tail, backup
  downloads, actions (backup, update check, restart) and Prometheus metrics.
- `skald-web`: Bun + Hono server and React dashboard. Password login (argon2id,
  rate-limited), live updates over WebSocket, SQLite event history, rankings,
  player profiles with streaks and badges, downloadable backups, press-and-hold
  actions, live log, PWA, optional campfire ambience.
- English and Polish UI with a per-viewer language switch; `SKALD_LOCALE` sets
  the default.
- `SKALD_TZ` for calendar days (streaks, daily playtime, badges).
- Optional Prometheus resource charts (`PROM_URL`), with an explanatory empty
  state when not configured.
- `skald-web hash-password` to generate `PANEL_PASSWORD_HASH` from stdin.
- `COOKIE_SECURE` and `TRUSTED_IP_HEADER` for plain-http and reverse-proxy setups.
- Docker Compose and Kubernetes (kustomize) examples, a PrometheusRule and a
  Grafana dashboard.
- Multi-arch images (`linux/amd64`, `linux/arm64`) for both components.
