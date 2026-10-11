# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.8.4] - 2026-10-11

### Added

- English and Polish names for 972 of the game's 983 items, as the game itself names them, so chests, village stores and search read like the game in both languages.

### Changed

- Map places use the game's own English and Polish names.

## [0.8.3] - 2026-10-11

### Fixed

- The admin world keys list showed the world's creation modifiers as one long unbroken key that ran off the screen; it now reads "World modifiers: resources much more, portals casual", and long keys wrap.

## [0.8.2] - 2026-10-11

### Changed

- Every dependency is up to date, majors included: TypeScript 7, Tailwind 4, Vite 8, Vitest 5, motion 14, Go 1.27, Bun 1.4, Node 24 LTS for the web build, Python 3.14, .NET 10 SDK (plugins still target the Unity runtime), xunit v3, and the newest release of every GitHub Action.
- Node stays on the 24 LTS line rather than 25 (end of life), and Python on 3.14 until 3.15 has images and wheels.
- Dependabot groups updates per ecosystem each month, with majors in their own group.
- Contributing, security, configuration and bridge docs brought up to date; the raid log line is confirmed on Valheim 1.0.

## [0.8.1] - 2026-10-11

### Changed

- Shorter, plainer README; the admin bridge caveats moved to the configuration guide.
- Releases now publish their GitHub release automatically after the images, with notes from this changelog.
- CI cancels superseded runs, caches Go modules, Docker layers and the bridge reference assemblies, and Dependabot watches dependencies.

## [0.8.0] - 2026-10-10

### Added

- Admin bridge (opt-in): live admin commands through the Skald bridge, a
  server-side BepInEx plugin (`bridge/`, plugin 0.1.1) that listens on the
  game pod's loopback only. New image `skald-bridge` (busybox with the DLL and
  an install script, used as an initContainer that also removes older copies);
  its build fetches the game's reference DLLs anonymously (about 2 MB through
  DepotDownloader) and never ships them. Kustomize component `bridge`,
  Compose profile `bridge`.
- Agent: `BRIDGE_URL`, `BRIDGE_TOKEN`, `BRIDGE_TESTED_BUILDS`;
  `/bridge/status` (with the game build and whether it is tested),
  `/bridge/players`, allow-listed reads and commands, `X-Skald-Actor` passed
  to the plugin's audit line. Player names are swapped for uids inside the
  agent; uids, platform and PlayFab ids never leave it, and the ban list is
  served by opaque ids. Commands on an untested game build wait for an admin
  to confirm the build. The plugin's audit lines become `admin` events with
  names, never ids. Live `positions` every 2 s while someone watches and
  someone plays, never stored or replayed.
- Web tier: `/api/admin/*` with the same allow-list; an optional admin
  password (`ADMIN_PASSWORD_HASH`): with it the panel password only views,
  and admin commands, restarts, backups, updates and settings need an admin
  session (rate-limited unlock, 30 minutes idle). Admin events are kept in
  the history. The mock agent has a fake bridge with players walking around.
- Dashboard: an admin sheet (header button; on phones in Settings) with
  broadcast and presets, players with health, items (search in English and
  Polish over the icon sheet, amounts, quality, kits saved on the device),
  time (sun and moon dial, skip to morning, freeze), raids, creatures, world
  keys with explanations, base helpers, save and the ban list; a player sheet
  (teleport to the base, a place, another player or a tapped point; items,
  heal, Rested; kick and ban held, ban with the name typed); live players on
  the map, gliding between samples; a long press on the map for teleport,
  spawn and table pins; admin actions in the Saga; a banner saying why
  controls are off (bridge off, disabled after a patch, untested build).

## [0.7.0] - 2026-10-10

### Added

- Item icons (opt-in). A `skald-icons` sidecar (new image) builds an icon
  sheet from the operator's own installed game server files, read-only: it
  follows each item prefab's ItemDrop to its inventory sprite (no name
  guessing), reads about 100 MB of the bundles, writes a WebP sheet and a
  map to its own volume, and rebuilds when the game updates in place.
  Skald ships no game assets. The agent serves them (`ICONS_DIR`,
  `/icons/map.json`, `/icons/sheet.webp`, `/state.icons`), the web tier
  proxies `/api/icons/*`, and the storage views show each item's icon in
  slots, graves, cluster lists, the village stores and the map search, with
  the category mark as fallback. Zoomed in, containers on the map show the
  four kinds they hold most of. Compose profile `icons`, kustomize
  component `icons`.
- Terrain (opt-in). A terrain job runs the operator's own dedicated server
  image once with a new BepInEx plugin (image `skald-terrain`) that samples
  the game's own world generator for the save's seed and quits without
  starting a server. The agent checks the grids against the save, paints
  them with its own palette and a hillshade (`TERRAIN_DIR`,
  `/terrain.png`, `/terrain.json`, `/state.terrain` with the request a run
  needs), and the map draws the land from it under the explored fog. The
  job asks the agent first and does nothing when the terrain is current.
  Kustomize component `terrain` (daily CronJob), Compose profile `terrain`.
- The mock server generates its own icon sheet (plain shapes) and terrain
  (its map's noise), so development needs no game files.

## [0.6.0] - 2026-10-10

### Added

- Player storage. The agent reads what is in every chest, cart and ship a
  player built (Valheim 1.0's compact inventory format, documented in
  `agent/internal/worldmap/inventory.go`) and in graves, and adds it to the
  map snapshot; world-generated chests (treasure, shipwreck, dungeon loot) are
  never read. Crafter names follow `MAP_SHOW_NAMES`; crafter ids are never
  read. An inventory in a layout the agent does not know is marked unreadable
  rather than guessed at.
- `/api/storage`: the containers alone, cut from the cached map with their own
  ETag.
- Map: a Storage layer with the chests; chests, carts, ships and graves open as
  a slot grid (stack counts, quality stars, durability and maker on tap);
  carts and ships say what they are loaded with; the map search finds items.
- Village stores (the Saga tab on phones, a board on wider screens):
  everything in the stores added up by kind, searchable in English and
  Polish whatever the UI language ("iron" and "żelazo" both work); an item
  lists where it is, most first, and "Show on map" opens that container with
  every place holding it ringed.

- Phone layout (up to 639 px wide, and landscape phones): a bottom tab bar
  with Fire, Map, Saga (saga, ranking, who sat by the fire) and Settings
  (server settings, language, campfire sound, log out, runes, forge,
  treasury, chronicle). Tabs are URL hashes (`#map`, `#saga`, `#settings`),
  so Back returns to the fire. Wider screens keep the full dashboard.
- Share for the join code: the phone's share sheet gets "Join <server> in
  Valheim: code 123456, password ...", with an "Include password" switch
  (on by default, remembered per device); where there is no share sheet the
  same text is copied. The password is fetched only when Share is pressed.
- A compact bar with the code, copy and share slides down on phones once the
  join code has scrolled away.
- Map clusters: crowded marks gather per zoom level into one mark with a
  count, bases, portals and graves leading pins and places; a tap zooms in
  until they split, and a pile that never splits (a portal hub) opens as a
  list. Bases take the name of a home pin next to them.
- Map on touch screens: double tap zooms in, a two-finger tap zooms out,
  "go to the main base" and "fit" replace the +/- buttons, mark details open
  as a bottom sheet that peeks at its content and drags up to full height,
  and "Go to the other end" selects the portal there. The view is remembered
  for the browser session.

### Changed

- The map opens on the explored area (or, without a cartography table, on
  bases, portals and graves; far-flung pins no longer stretch it), clear of
  its controls, on every screen size.
- Labels: portal tags, base names and graves show from the first view;
  labels never leave the screen, and phones get fewer, larger ones.
- The header on phones is one line of status and one row of facts.
- Touch screens get 44 pt targets throughout, 16 px fields (no iOS zoom on
  focus), larger layer switches, and safe-area insets (`viewport-fit=cover`)
  for notches and the home indicator, in the browser and installed.
- The theme colour matches the night sky behind the header.

## [0.5.0] - 2026-10-10

### Added

- World map. The agent builds it from the newest finished save (Valheim 1.0
  chunk files): land and water per 64 m zone, the cartography tables'
  explored area and pins, portals and their pairs, graves with the day of
  death, beds, ships and carts, bases, terrain edits and the seed's boss,
  trader and dungeon locations. Rebuilt at most once a minute, only after a
  new save, and only the chunks the game rewrote are parsed again. Served as
  `GET /map` (agent) and `GET /api/map` (web), with an ETag and gzip.
- A full-screen map at `#map` and a map board on the dashboard: parchment
  look, fog over the unexplored, pan, zoom, pinch and fling, layer toggles
  with counts, legend, search, popovers with a link to the same spot on
  valheim-map.world, and a Terrain tab that embeds the seed's terrain from
  that site.
- `MAP_SHOW_NAMES` (agent, default on) and `MAP_SPOILERS` (web, default off).
- `world.clock` in `/state` and the header: the time of day, and "world
  asleep" when nobody is on and time stands still.
- Metrics `valheim_map_build_seconds` and `valheim_map_generation`.

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
