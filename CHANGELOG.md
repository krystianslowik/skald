# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). From 2026.10.0 on, the project
uses calendar versioning, `YYYY.M.N`: the year, the month without a leading zero,
and a counter that starts at 0 each month (2026.10.0, 2026.10.1, 2026.11.0).
Releases up to 0.10.2 used semantic versioning. A calendar version always sorts
above them.

## [Unreleased]

### Changed

- Live player positions are only fetched from the game while someone has the map or a player list open, and only sent to the browsers showing them. Phones on the other tabs no longer receive a position update every 2 seconds, and the game is not asked for positions when nobody looks. Older agents and older open dashboards keep working as before until they are updated.

## [2026.10.4] - 2026-10-16

### Changed

- The map draws its terrain on the graphics chip where the browser supports WebGL2 (every current phone and desktop browser), so panning, pinching and flinging stay smooth while terrain streams in: arriving tiles no longer redraw anything, and a sharper tile fades in over the blurry one in about a quarter of a second instead of popping in. The map looks the same as before, with the same colours at every zoom. Woods and floor plans are drawn a small piece at a time instead of all at once when you leave the area they cover. Browsers without WebGL2 keep the previous drawing.
- The map's terrain no longer waits for the game where nobody has looked yet. Once per game build the agent bakes the whole world's terrain tiles in the background, the whole-world view first, then full detail from the centre outwards. It takes about 67 minutes on an empty server and about 3.7 hours while people play, and it always steps aside while someone looks at the map. Progress shows in `/terrain/tiles.json` and the new `valheim_terrain_bake_progress` metric; `TERRAIN_BAKE=false` turns it off.
- **Operators:** a baked world takes about 0.5-0.85 GB on the agent's tile cache (the config volume in Kubernetes), and the default `TERRAIN_CACHE_MB` rises from 256 to 1024 to hold it. A game update bakes again and replaces the old tiles.
- Map tiles are fetched nearest to where you look first, and tiles for a place you already scrolled away from are no longer sampled.

### Fixed

- Count badges on clustered marks were drawn again on every frame on some pages, which made the map stutter with long pauses while it moved.

## [2026.10.3] - 2026-10-16

### Changed

- The map no longer shows bare parchment while terrain loads. The whole world's coarse terrain is fetched as soon as the map opens and kept, so zooming out or flying across the map shows a blurry version of the place at once, and tiles already loaded closer in stand in while the coarser ones arrive. Until the first, coarsest tile is in, the map shows the land from the save. Each arriving tile redraws only its own part of the map instead of the whole map, which makes panning and zooming far smoother while terrain streams in, and tiles are painted at screen resolution, so the map holds about a quarter of the memory and fills a view with fewer requests.

## [2026.10.2] - 2026-10-16

### Changed

- The admin sheet says first when your session is view-only, with the Unlock button at the top, instead of at the bottom after all the controls.
- The panel loads faster on phones: skald-web now sends pages, scripts and data gzipped (about a third of the bytes on first load), and the fonts come with the panel instead of from Google Fonts, so no third-party request is made and the viewer's address is not shared with Google. The page no longer shifts when the fonts arrive.
- The rising embers draw at 30 frames a second and stop while the map is open, which roughly halves the panel's idle CPU use on a phone.
- A panel left open in a background tab no longer refetches the dashboard and admin status; it catches up once when you look at it again.

### Fixed

- Polish process names in Settings now agree with their state ("harmonogram kopii zatrzymany", "aktualizator działa" instead of "kopie działa"), and the item-locations and map-layers sheets' close buttons say what they close ("Close item locations", "Close layers") instead of "Close map".
- On a tablet (about 640 to 1023 px wide) the header no longer squeezes the server name and status into a sliver beside the version and buttons: the name and status keep their own row, with the facts and buttons below them, until the screen is wide enough for one row.
- On a phone, the Terrain tab's note about the external site now runs across the full width under the credit and the "Open in a new tab" link, instead of a column one word wide that took a third of the screen.
- On narrow phones the Treasury cut off the time of each backup and its file name, so backups from the same day looked alike. The date and time now wrap onto a second line when space is short, and the full file name is always shown. The restore list in the admin sheet keeps the time the same way.

## [2026.10.1] - 2026-10-16

### Fixed

- The Saga filled with "Admin: GET /v1/terrain/tile failed (too many terrain requests)" while someone browsed the map. Reads such as the map's terrain tiles came back through the bridge's audit trail as failed admin commands. They are no longer stored, shown or sent to Discord, and lines already stored are hidden.

## [2026.10.0] - 2026-10-16

The first calendar-versioned release (it follows 0.10.2). When upgrading:

- **Terrain tiles** need the bridge 0.2.0 image (`skald-bridge`) next to the 2026.10.0 agent.
- **Admins, bans and world restore** only work if the agent can write the config volume. See "Admins, bans and world restore" in docs/configuration.md; otherwise they stay read-only.
- **Discord and the update check** need skald-web to reach the internet on port 443.
- **Viewers and the server password:** with `ADMIN_PASSWORD_HASH` set, viewers no longer see the server password.

### Added

- Discord notifications. Set `DISCORD_WEBHOOK_URL` and skald-web posts joins and leaves (with the visit length), deaths, raids, server stops and starts, new join codes, game updates and failed admin commands or settings to a Discord channel, in the `SKALD_LOCALE` language. `DISCORD_NOTIFY` picks which ones. Players arriving together share one message, a quick restart does not flap, world saves are never sent, and nothing from before skald-web started is repeated. The admin sheet says whether notifications are on and sends a test message.
- Admins and bans in the admin sheet: see who is on `adminlist.txt` and `bannedlist.txt` (by name where Skald knows the player), add an id by hand or a player at the fire in one tap, and remove entries. Bans go through the bridge when the game runs with it and apply at once; otherwise the file changes and the change applies at the next start. Comments and unknown lines in the files are kept. Every change is a line in the Saga, without the platform id.
- Restore a world backup from the admin sheet, from the image's backups or Skald's own safety copies. It needs the world name typed and an empty server, saves and verifies a copy of the current world first, stops the server, puts the backup in place and starts the server again, with each step in the Saga. Any failure after the stop puts the previous world back. See [Admins, bans and world restore](docs/configuration.md#admins-bans-and-world-restore).
- The admin sheet opens without the bridge too, with the Discord status, the lists and backups.
- The map's terrain can now come from the running server: with the admin bridge installed, the agent samples the live world generator in tiles, from the whole world down to 0.64 m per pixel near the view, so biome borders and coasts are right to the metre around bases. Tiles are always for the running game build, so a game update no longer needs a new terrain run or a 2 GB download, and they are cached on disk per seed, generator and build (`TERRAIN_CACHE_DIR`, `TERRAIN_CACHE_MB`).
- Bridge 0.2.0: read-only `GET /v1/terrain/info` and `GET /v1/terrain/tile`, sampled off the game's main thread, one tile at a time, rate-limited and capped to half a core (`SKALD_BRIDGE_TERRAIN`, `SKALD_BRIDGE_TERRAIN_RATE`, `SKALD_BRIDGE_TERRAIN_DUTY`). It also reads the game's own minimap colours and forest mask when it can.
- Metrics: `valheim_terrain_tiles_total`, `valheim_terrain_bridge_sample_seconds_total`, `valheim_terrain_cache_bytes`.
- Every part of Skald now knows its release. The panel shows "Skald 2026.10.0" in small print under the phone's Settings tab and at the foot of the admin sheet, and says calmly when the agent and the panel run different releases ("Agent 2026.10.0, panel 2026.11.0: update the other part so they match"). The agent reports it in `/state`, the icon extractor in `map.json`.
- Metric `skald_build_info{component, version}` from the agent (`:9464/metrics`) and from skald-web, on a separate metrics listener that is off unless `METRICS_BIND` is set (`0.0.0.0:9465` in the Kubernetes example, which also scrapes it and keeps it to the monitoring namespace).
- Update check: skald-web asks GitHub once at start and at most every 12 hours whether a newer Skald release is out, and the admin sheet shows "New version 2026.11.0" with a link to the release notes. A plain request with no identifying data; it fails quietly where the network is blocked (the example Kubernetes NetworkPolicy blocks it until you uncomment its rule). `SKALD_UPDATE_CHECK=off` turns it off. See [Versions and the update check](docs/configuration.md#versions-and-the-update-check).

### Changed

- Game build `l-1.0.20` is a tested build for the admin bridge, so admin commands run on it without a confirmation from the panel.
- Floor plans show their roofs when zoomed out: a translucent roof lies over each house, so a base reads as buildings from afar, and fades away as you zoom in until the rooms are clear. This includes one-storey houses, whose roofs were never drawn before. A storey picked in the floor switcher shows without it.
- With item icons on, floor plans take their colours from the materials they are built of: wood, core wood, stone, iron, black marble, grausten and ashwood each get a tone from their item icon. Without icons the plans look as before.
- Admins, bans and world restore need the agent to write the config volume, which the example deployments do not allow; the sheet shows the lists and backups read-only until it can.
- The terrain looks like the game's map: biome colours, darker forest, relief and water by depth, painted the same way at every zoom, so a place keeps its colour as you zoom in. Swamps are dark mud with water pools instead of beige patches with outlines, and biome borders are smooth curves instead of blocks. Tiles are painted in a background worker, at most four load at once, nearest the view first, and tiles that leave the view are cancelled.
- The terrain Job stays as a fallback: when the bridge is not reachable, its grid serves the low zoom levels and the terrain image as before.
- With `ADMIN_PASSWORD_HASH` set, the server settings sheet and the server password are the admin's: a viewer is asked to unlock first, and `GET /api/settings/password` answers 403 without an admin session. On the join panel a viewer shares the join code alone.
- The Forge card is even: the processor, memory and network gauges are built the same way, each with its bar, chart and legend. The world facts, modifiers and processes sit in one band under them.
- Processes read by what they do ("game server", "backups", "updates"), a finished first-start bootstrap shows as done instead of a red "exited", and the container's cron and syslog fold into one "system" line. Every state is translated.
- The Runes of power are three compact rows, each the thing to press and hold, with the status in words and a line of fire along the bottom while held. Beside the Treasury they share its height.
- On wide screens the join code and the players at the fire sit side by side, centred on each other, and an empty fire is one quiet line instead of a tall empty board.
- Close in on the map, a wood has one outline round its edge instead of one round every tree, and trees are drawn by species: swamp trees dark, small and gnarled, conifers as low stars, birches small and light, oaks broad.

### Fixed

- Rocks and logs on the seabed no longer draw inside lakes and the sea. Anything more than 4 m under the water is left out of the map's nature; beach stones, swamp trees and ore deposits stay.
- The development mock's terrain now has swamps, forests and mist lands; its noise was faded out far from the centre, so they never appeared.
- The player count drops back to 0 when the last player leaves. The game's "connection lost" line still counts the player who just left, so the count used to stay at 1 until the next join or restart: "apply settings when the server is empty" never fired, the agent kept asking the bridge for positions with nobody on, and `valheim_players_online` stayed at 1. The game's 10-minute network summary showing 0 connections now also resets it.
- The day labels on the 7-day online chart stay on local midnight across a daylight saving change. After the autumn change they used to sit an hour early, under the previous day's name, with Sunday shown twice.
- A pile of chests each pushed a little sideways (0.4 to 0.6 m is common) lost its bottom chest, which the map then counted as a stack of its own: the stack label was off by one. Chests now stack when their footprints overlap and one stands a level (or a shelf) over the other, so a pile stays whole and two columns side by side stay apart.
- A stack of chests is listed as it stands, the top chest first, so "1st from the bottom" is the lowest row of the list.
- Boss altars marked by a Vegvisir showed the game's raw token ("$enemy_gdking"); they now carry the boss's name, and any other token is put into words.

## [0.10.2] - 2026-10-16

### Changed

- The Saga keeps the last 200 real events (joins, deaths, raids, admin commands) however often the world saves. Routine saves and backups are kept only for the span those events cover, and at most a week, so they can no longer push everything else out after a few days.
- Routine saves and the game's backups fold into one quiet line per stretch, such as "World saved 47×, 12 backups · last 16:09"; tap it to see each one. A save that took 2 seconds or more stays on its own line, in gold.
- A visit reads as one line, "Freya 18:35–19:39 · 1 h 4 min", or "Freya playing since 18:35" while she is still in. Deaths and raids during it keep their own lines.
- A new game version after an older one reads "Game updated to 1.0.20".

### Fixed

- A stack of chests on the map now has the "Open on full map" link like every other mark.

## [0.10.1] - 2026-10-11

### Changed

- The map is much smoother on phones. Panning no longer stalls on the fog edge in Safari, dense woods and the fog no longer freeze Chrome on Android for seconds, opening the map and a world save no longer block the page (the map's shapes are built in a background worker), and newly loaded woods and floor plans arrive in small steps instead of all at once.
- Pinching past the closest or farthest zoom stretches a little and springs back, a quick pinch keeps zooming briefly after you let go, and a finger that stopped before lifting no longer flings the map.
- The app's hashed files are cached by the browser for good, so returning visits load almost nothing.

### Fixed

- A fling or zoom that started while clustered marks were splitting apart did not move.
- On large retina screens the map could stay blank in Safari, which refuses very large canvases.

## [0.10.0] - 2026-10-11

Nature and resources on the map need the 0.10.0 agent; with an older agent the web keeps working without them.

### Added

- The agent serves the land's nature for close zoom: `GET /nature` returns the trees (by species), stumps, fallen logs, rocks, bushes, ore deposits and pickables the world generated inside a box, as they are now. Without map spoilers only what lies on explored land or near a base is sent.
- Nature and Resources layers on the map: zoomed in, the land fills with hand-drawn woods (tinted by tree species), rocks, stumps, fallen logs and bushes, and ore deposits are marked in their metal's colour. Tap a deposit to see what it is, what it yields and where. Closer still, berries, mushrooms, flint, stones and branches show as small dots. With an agent that has no nature yet, both layers simply stay empty.

## [0.9.1] - 2026-10-11

### Changed

- The map zooms four times closer than before, down to about 16 metres across a phone screen: walls, doors, stairs and single chests read one by one, and live players can be followed from room to room. Marks and labels keep their size at every zoom, and a jump from search or the village stores made while zoomed all the way in lands a little further out, so the surroundings stay in view.
- The floor switcher opens on a base's main storey, the one with the most floor, instead of the lowest one, so a yard or jetty of floor pieces under the house no longer hides the house behind "1st floor". Ground is still the lowest level, and a storey you pick stays picked for that base until the page is reloaded.

## [0.9.0] - 2026-10-11

Floor plans and chest stacks need the 0.9.0 agent; with an older agent the web keeps working without them.

### Added

- The agent serves floor plans of what players built: `GET /pieces` returns the walls, floors, roofs, doors, stairs, stations and the rest inside a box, each with its position, height, heading and footprint, for drawing bases at close zoom.
- Every chest, cart and ship on the map and in the village stores carries its height (`y`, in metres), so chests stacked on one spot can be told apart; container positions are now given to 5 cm instead of whole metres, and stacked chests on the same metre are numbered from the bottom up.
- A Buildings layer on the map: zoomed in close, bases are drawn as an inked floor plan on the parchment, with walls, floors, doors, stairs, workbenches, chests and fences. Bases with more than one storey get a floor switcher (Ground, 1st floor, ... Roof); the storey below shows faintly, and "Show on map" from the village stores opens the chest's own storey.
- Chests stacked on one spot are one mark on the map with a count, and open as a stack listing each chest bottom to top. The village stores, the map and its search say where a chest sits ("3rd from the bottom of 3").

## [0.8.6] - 2026-10-11

### Changed

- The map stays sharp up close: the edge of the explored land and the coastline are drawn as clean ink lines at every zoom, and the blurry terrain image fades into parchment as you zoom in.

## [0.8.5] - 2026-10-11

### Changed

- Village stores is a compact bag of item slots, biggest stacks first, with swipeable kind chips and counts. It shows a few rows until you ask for the rest, so a big village no longer turns the board into a page-long list.
- More ready-made admin kits, with names in English and Polish, and a pass over the Polish copy.

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
