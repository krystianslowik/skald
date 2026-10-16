# Integrating the bridge into Skald

> Implemented in Skald 0.8.0; the current setup is in
> [docs/configuration.md](../docs/configuration.md#admin-bridge). Kept as the
> design notes the integration followed. The Xbox checks in sections 5 and 6
> have since been run; the results are under "Verification status" in
> [README.md](README.md#verification-status-l-1017-2026-10-10).

This is a plan for whoever owns `agent/`, `server/`, `web/` and `deploy/`. The
bridge itself (`bridge/plugin`) is done and runs on the test server. Nothing
outside `bridge/` was changed.

The chain stays as it is today. The browser talks only to the BFF, the BFF talks
only to the agent, and only the agent talks to the plugin:

```
browser --cookie--> server (BFF, Bun) --X-Agent-Token--> agent (sidecar) --X-Skald-Token--> plugin 127.0.0.1:9010
```

## 1. Agent (Go, `agent/internal/server`)

### Config

| Env | Meaning |
|---|---|
| `BRIDGE_URL` | Default `http://127.0.0.1:9010`. The agent and the game share the pod network namespace, so loopback reaches the plugin |
| `BRIDGE_TOKEN` | Same value as the game container's `SKALD_BRIDGE_TOKEN`, from one Secret key |

If `BRIDGE_TOKEN` is empty, the bridge routes are not registered at all. This
matches how `/settings` behaves without `SETTINGS_DIR`. The web then hides the
admin panel (see `GET /bridge/status` below).

### Routes

Add these behind the existing `requireToken`:

| Agent route | Plugin call | Notes |
|---|---|---|
| `GET /bridge/status` | `GET /v1/health` | `{available, plugin, gameBuild, worldLoaded, timeFrozen}`. `available:false` when the plugin is unreachable or answers 503 |
| `GET /bridge/players` | `GET /v1/players` | Map the result to `{name, platform: "Steam"/"Xbox"/…, x, y, z, health, maxHealth}`. **Drop `uid`, `platformId`, `userId` and `playfabId`.** Keep a private name -> uid table in the agent for the commands below |
| `POST /bridge/{command}` | allow-listed `/v1/...` | One allow-list in Go, see below. The agent swaps a player **name** coming from the web for the uid before forwarding, so platform ids never travel up the chain |

Allow-list (agent command -> plugin path). Start with priority 1 and leave the
rest switched off until each one has been checked in game:

```
broadcast        POST /v1/broadcast
save             POST /v1/save
kick             POST /v1/kick
ban              POST /v1/ban
unban            POST /v1/unban          (takes a ban-list entry; see privacy)
time             POST /v1/time
skip-to-morning  POST /v1/time/skip-to-morning
event-start      POST /v1/events/start
event-stop       POST /v1/events/stop
spawn            POST /v1/spawn
teleport         POST /v1/teleport
globalkey-set    POST /v1/globalkeys/set
globalkey-remove POST /v1/globalkeys/remove
GET: events, globalkeys, locations, bans, time
```

### Proxy rules

- Always forward a JSON body, `{}` at minimum. The plugin's listener answers
  411 to a POST without Content-Length.
- Set `X-Skald-Actor` to who clicked. Today the BFF has one shared password, so
  pass `dashboard` plus a short session hash. Do this from the start so the audit
  line is useful once real users exist.
- Use a client timeout of 8 s. The plugin's own main-thread budget is 5 s.
  Map plugin statuses as they are: 400, 404, 409, 501 and 503 pass through
  verbatim. A connection refused or a timeout becomes 502 with "bridge
  unavailable".
- Do not take the existing `s.busy` lock for bridge commands: they are fast,
  and the plugin serialises them on the main thread anyway. Keep `busy` for
  restart, backup and update. Refuse bridge commands only **while a restart is in
  flight**, because the plugin is down then.

### Audit

The plugin already writes
`[SkaldBridge] audit actor=… cmd=… args=…` and `… result=…` to the game log. The
agent's syslog feed sees those lines. Two pieces of work:

1. `logparse`: recognise `[SkaldBridge] audit` lines and emit an `admin` event
   on the hub. Use the same Chronicle stream as `action` events, so the web
   timeline shows "Kicked X", "Spawned 20x Wood for Y".
2. Redact before publishing: drop `args`, which can carry a platform id on
   ban/unban, and keep only `cmd`, `actor`, `result` and the player **name**.
   The full line stays in the pod log and Loki for the operator.

### Live player positions on the map

- The agent polls `GET /v1/players` every **2 s**, and only while at least one SSE
  client is connected and the game reports more than zero players. The call
  runs on the game's main thread but costs a few microseconds per player.
- Publish an SSE event `positions` with `{t, players:[{name, x, z, health,
  maxHealth}]}`. Leave out `y`: the map is 2D. When nothing has changed, skip the
  event. The web interpolates between samples (`lib/mapmotion.ts` already exists
  for this).
- Privacy:
  - Positions are behind the dashboard login, like the rest of the map.
  - Platform ids never leave the agent.
  - Mirror the game's own "hide my position" choice: `ZNet.PlayerInfo.m_publicPosition`
    is not exposed yet. If it is wanted, add a `public` flag to `/v1/players` and
    have the agent drop non-public players unless an admin toggle is on.
- The `/metrics` listener must not get positions.

### Terrain tiles

`internal/terrain/tiles.go` turns the plugin's terrain routes into a tile
pyramid, `GET /terrain/tiles.json` and `GET /terrain/tile?z=&x=&y=&v=`.

- Level `z` cuts the square `[-10500, 10500]^2` into `2^z x 2^z` tiles of
  256 px: level 3 is 2048 px across, the Job's grid one to one; level 7 (the
  top) is 0.64 m per pixel. Each tile is asked for with a two-sample apron on
  every side (`n = 260`), so the web computes slopes at the edge exactly as the
  neighbouring tile does and tiles meet without seams.
- The cache key (and the `build` in every tile URL) is the seed hash, world
  generator version and game build **as the plugin reports them** from the
  running world, plus the tile format. A game update is a new build: old URLs
  404, new tiles are sampled. Tiles are `immutable` with an ETag.
- Disk cache under `TERRAIN_CACHE_DIR` (default `$SETTINGS_DIR/terrain-tiles`),
  bounded by `TERRAIN_CACHE_MB` (1024), least recently used out first (recency
  is the file mtime, so it survives restarts). An unwritable directory falls
  back to a 64 MB memory cache.
- One plugin call at a time (`internal/terrain/queue.go`). Viewers' tiles wait
  in a priority queue, nearest the centre of the latest 16 requests first
  (cache hits count: they move the view too). Everyone asking for the same
  tile, viewers and the bake, shares one job. A queued tile is dropped before
  sampling when its last viewer's request is cancelled, or when it is
  superseded: viewers asked for other tiles since, and none of them within 10
  of its own tile widths (answered 503). A tile already being sampled finishes
  and is cached. 429s are retried with back-off.
- The bake (`internal/terrain/bake.go`, `TERRAIN_BAKE`) fills a build's whole
  pyramid in the background, taking the slot only when no viewer waits and
  never within 2 s of a viewer request: levels 0..3 (85 tiles), then level 7
  in level-4 blocks from the centre out. Levels 4..6 are downsampled in the
  agent from the level below as soon as a tile's 4 children and their 12
  neighbours are on disk: biome by the mode of the 2 x 2 samples (ties to the
  north-west-most; a mean of biome indices means nothing), height and forest
  by the rounded mean (the coarse pixel's centre is the four samples' centre).
  Tiles with a child outside the world disc (164) are sampled at the end. It
  paces itself to one bridge call per 300 ms (1 s with players online), under
  the plugin's 4/s limit, and stops when the build fills 90 % of the cache.
  The cache is the progress: a restarted agent skips every tile on disk.
  `tiles.json` carries `bake: {state, done, total, level}`.
- The Job's grid is used for levels 0..3 only when it is from the same seed,
  generator and game build and the plugin has no forest channel (grid tiles have
  none, and mixing them with forest-shaded tiles would change a place's colour
  between zoom levels), or when the plugin is unreachable (then the pyramid
  stops at level 3 and `source` is `grid`). Without either, `/terrain/tiles.json`
  is 404 and the web uses `/terrain.png` as before.
- Tiles are served gzipped in the plugin's format, with heights packed for
  gzip first: flag 4 (never set by the plugin) means each row is stored as
  west-to-east differences, low bytes of the whole grid then high bytes. About
  half the size on real terrain.
- `/metrics`: `valheim_terrain_tiles_total{result}`,
  `valheim_terrain_bridge_sample_seconds_total`, `valheim_terrain_cache_bytes`,
  `valheim_terrain_bake_progress`.

Why sampling off the main thread is safe, from the game's own structure (read
by reflection, not from its code): `HeightmapBuilder` starts its own thread
(`m_builder`) whose `Build` calls `WorldGenerator.GetBiome` and
`GetBiomeHeight` while the main thread uses the same generator; the river
cache those reach is guarded by `m_riverCacheLock` (a `ReaderWriterLockSlim`).
`GetBiome(Vector2s)` and `GetBiomeArea`, which fill unsynchronised static
dictionaries, are deliberately not used. The forest value is the minimap's own
mask, `Minimap.GetMaskColor(x, z, height, biome).r`, which reads only statics
and the world generator, so it is called on an uninitialised `Minimap` object
(a dedicated server has no live minimap); failing that, the static
`WorldGenerator.GetForestFactor`. The minimap's biome colours are instance
fields of the client's prefab; on a dedicated server they are usually not
there, and the web uses its own tuned colours (`palette.source` says which).

## 2. BFF (`server/src`)

- Add `agent.bridge(command, body)` and `agent.bridgePlayers()` to
  `agent.ts`, and implement both in `mock.ts` so `MOCK_AGENT=1` keeps working: fake
  positions drifting around spawn, and canned responses.
- Add `POST /api/admin/:command`, behind `authed(c)`, with the same allow-list
  repeated, and a body size cap of 4 KB.
- Add `GET /api/admin/status` and `GET /api/admin/catalog`. The catalog is the
  event names, global keys and location aliases, cached for 60 s.
- Re-broadcast `positions` from the agent SSE to the WebSocket hub. Rate limit
  to one message every 2 s per socket.

The terrain routes are proxied as `/api/terrain/tiles.json` (no-cache) and
`/api/terrain/tile` (the gzipped body passed through untouched, private,
immutable; 404 and busy answers are `no-store`). `bun run dev` serves mock
tiles from the mock's noise (`src/mocktiles.ts`); `MOCK_TILE_DELAY_MS` adds a
delay per tile and `MOCK_TILES=off` hides them.

## 3. Web UI (`web/src`)

A new **Admin** sheet, opened from the header next to Settings. Show it only when
`/api/admin/status` says `available`.

- **Broadcast box**: a text field (300 characters) plus a style toggle: Center /
  Corner / Narrator (chat lines are not possible, the plugin answers 501). In the panel, add canned lines and "send on
  event" hooks, for example "Raid incoming" when an event starts and "Saving…"
  before the nightly restart. The agent sends these through the same `broadcast`
  command.
- **Players list**: rows from `positions` with name, platform glyph
  (`PlatformGlyph.tsx`) and a health bar. Each row has:
  - Teleport to… (a player, a map click, or a named spot from the catalog)
  - Give items
  - Heal, available once priority 2 is enabled
  - Kick and Ban
- **Item picker**: search over the item names from the icon sheet that
  `agent/internal/icons` already builds. Show the icon, then amount and quality
  steppers. Kits are saved presets ("Starter", "Bronze age", "Boss prep") stored
  in the BFF's sqlite (`db.ts`). Sending posts `items:[…]` in one call.
- **World**:
  - time: a day-fraction slider, "Skip to morning", and later freeze/resume
  - raids: the current event with Stop, or Start with a picker and target player
  - global keys: chips with add/remove; mark boss keys and `nobuildcost`
  - Save now
- **Map integration**:
  - live player markers from `positions`
  - right-click a point: "Teleport player here", "Start raid here", "Drop items here"
- **Confirmations**:
  - kick, ban, removing a boss key and stopping a raid need a
    **hold-to-confirm** button (1.2 s, with a progress ring)
  - ban also needs a typed confirmation of the player's name
  - spawning more than 10 stacks or any boss, and setting `nobuildcost`, get a
    one-tap confirm with the consequence spelled out
- Feedback: read the plugin's 501 messages verbatim. They already explain why
  something cannot be done server-side.

### Terrain tiles

`lib/terraintiles.ts` plans each view without knowing how tiles are drawn
(`planView`, `TileScheduler`): the level whose samples are about one pixel of
the canvas, the slots over the drawn box, and the load order. Level 0 comes
first, then the visible tiles nearest the centre, then, at low priority and
one at a time, a ring of one tile round the view and the rest of levels 0-3.
At most four load at once and those that leave the wish list are cancelled.
Levels 0-3 stay on the client for good once loaded; the rest of the painted
bitmaps sit in a byte-bounded LRU (40 MB on phones with 4 GB or less, 96 MB
otherwise). A missing tile shows its loaded descendants (two levels down) over
its nearest loaded ancestor, so once level 0 is in no slot is blank; until
then the map is inked from the save. An arriving tile redraws only the slots
it changes in the cached base. `lib/terraintile.worker.ts` fetches, ungzips, decodes and paints in a worker
and hands back an `ImageBitmap`; `lib/terrainpaint.ts` is the one paint model
for every level: biome colour, forest darkening, hillshade from centred
slopes, water by depth (swamp pools keep some mud), with biome borders as
smooth curves between samples. Tiles are painted 1:1 below 1 px/m, at 2x
closer in, and the top level at 4x when zoomed far in. Without a worker, `OffscreenCanvas` or
`DecompressionStream` the map keeps `/terrain.png`.

With WebGL2 (`lib/mapgl.ts`) the same plan is drawn on the GPU instead and
nothing is painted: 2-3 workers (`lib/terraindata.worker.ts`) only ungzip and
decode, and each tile goes up as raw data, one RGBA8 integer texel per sample
(biome, forest, height high and low byte, `packTile`), into one fixed
`TEXTURE_2D_ARRAY`, at most three uploads a frame. The fragment shader is
`paintTile` per screen pixel, reading the 4 x 4 samples round it with
`texelFetch`, so colours match the painted path at every zoom; paper, fog (a
signed distance field of the explored outline, `lib/fogfield.ts`) and the
world's edge are full-screen passes. A tile on the GPU but not yet faded in
counts as missing for `planView`, so its relatives stay under it while it
fades in over 250 ms, on arrival and when the drawn level changes (held 0.15
of a level past each boundary). Woods and floor plans are rasterized by
Canvas2D in 256 px world-anchored chunks, a few per frame, and composited from a
second texture array, so no frame redraws a whole layer. The marks stay on
a Canvas2D layer above, redrawn only when they or the view change. Without
WebGL2, or while a lost context is away, the painted path above is used. Before
first use the GPU path draws a known tile and a known chunk from a high array
layer and reads them back; on a mismatch or a GL error it logs the read-back
values and the painted path is used, as it is when arrived tiles cannot reach
the GPU for 5 s. `?map=canvas` or localStorage `skald.map.renderer=canvas`
forces the painted path.

## 4. Deploy changes to the game pod (`deploy/kubernetes/valheim.yaml` and the homelab manifest)

Roll these out deliberately, in a window with no players online. Every change to
the game pod restarts the game and rotates the join code.

1. **Game container env**:
   ```yaml
   - {name: BEPINEX, value: "true"}
   - {name: SKALD_BRIDGE, value: "on"}          # kill switch: "off"
   - {name: SKALD_BRIDGE_PORT, value: "9010"}
   - name: SKALD_BRIDGE_TOKEN
     valueFrom: {secretKeyRef: {name: valheim-agent, key: BRIDGE_TOKEN}}
   ```
   Effects of `BEPINEX=true`:
   - `bepinex-updater` downloads about 1 MB from Thunderstore at start and needs
     TCP 443, which the NetworkPolicy already allows.
   - The server binary is started from `/opt/valheim/bepinex`, and the image
     switches to that directory itself.
   - First boot is about 30 s longer. The existing 30-min startup probe covers it.
2. **Agent container env**: `BRIDGE_TOKEN` from the same Secret key.
   `BRIDGE_URL` can stay at its default.
3. **Plugin delivery.** Pick one:
   - **A, recommended: an init container from a tiny image.** Build
     `ghcr.io/krystianslowik/skald-bridge:<version>` `FROM busybox`, containing
     only `SkaldBridge.dll`. The init container runs
     `cp /SkaldBridge.dll /config/bepinex/plugins/`. It is pinned by digest and
     released together with the agent image.
   - B: a ConfigMap with `binaryData` (as in `bridge/k8s/test-server.yaml`). Fine
     for a homelab, but the DLL then lives in etcd and is versioned by hand.

   Either way, also **remove** stale copies: the image syncs
   `/config/bepinex/plugins` into the install, so a DLL deleted from the source
   can linger. The init container should `rm -f` the old name first.
4. **NetworkPolicy**: no change. Port 9010 is loopback only, and the policy never
   applies to pod-internal traffic.
5. **Kill switch drill**:
   - Set `SKALD_BRIDGE=off` and restart. The log shows
     `[SkaldBridge] loaded, kill switch SKALD_BRIDGE=off: serving nothing`, the
     agent's `/bridge/status` says unavailable, and the web hides the panel.
   - The other fallback is `BEPINEX=false`, which removes modding entirely
     and returns to vanilla.
6. **Version gate**: the agent reads `gameBuild` from `/v1/health`. Keep an
   allow-list of tested builds (`l-1.0.17`, `l-1.0.20`). On an unknown build, show "untested
   game build" in the panel and keep only the read-only commands until someone
   ticks it off.

## 5. Risks

- **Crossplay.** The test server ran with `BEPINEX=true` + `CROSSPLAY=true`:
  - it registered with PlayFab, joined a PlayFab Party network and got a join code
  - a server-side BepInEx plugin is invisible to clients, and Xbox clients need
    nothing installed

  Still unproven: an Xbox client actually joining a BepInEx server. That is the
  owner's test below. Until it passes, do not enable `BEPINEX` on the live pod.
- **Game patches.** Valheim updates whenever the pod restarts, because
  steamcmd runs first.
  - The plugin probes its members at load and disables itself (or a single
    command) with one clear log line.
  - The game never crashes from it.
  - RPC names are strings (`ShowMessage`, `RPC_TeleportPlayer`, `RPC_Damage`, …).
    A renamed RPC fails silently: the call is accepted and the client
    ignores it. Mitigations:
    - the build gate above
    - a smoke test after each game update (broadcast, then check a player saw it)
- **BepInEx pack lag.** A Unity upgrade can break BepInExPack before a new
  pack is out. The kill path is `BEPINEX=false` (vanilla), which works with no
  plugin rebuild.
- **Console clients.**
  - Teleport, heal and status effects are executed by the client on its own
    character. Xbox runs the same game code, but this is the part to verify on
    a real Xbox (see the test checklist).
  - God mode, fly, ghost, per-player free build and feeding are client-local:
    there is no server path, and console players have no dev console either.
- **Privilege.** Anyone with the dashboard password can spawn items, kill, ban
  and teleport. Keep the password strong and keep CF Access in front, as today.
  Treat the bridge token like the agent token.
- **Time freeze side effects.** Pinning net time also stops smelters, crops,
  fermenters and respawn timers. Label it as such in the UI.
- **Spawn abuse or lag.** The caps are 60 stacks per call, 20 creatures and
  radius 100 m. The UI should also rate-limit, for example one spawn per second.
- **Audit completeness.** The audit trail lives in the game log. If the agent's
  syslog feed drops lines, the Chronicle misses entries, but Loki still has them.
  (Since resolved: the agent now builds `admin` events from the commands it
  sends and the plugin's replies, not from the log lines.)

## 6. What still needs a human with an Xbox

Join code, password `change-me-test`; see the handover message for the current
code. Each item is a yes/no:

1. Can you join (crossplay intact with BepInEx)?
2. Did you see a center message and a narrator message (gold italic)?
3. Did items land next to you (Wood x120, SwordIron at quality 3), and could you pick them up?
4. Were you teleported to the coordinates, to another player (needs two) and to
   `toSpot: "spawn"`?
5. Did the sky go from night to morning after skip-to-morning, and to noon
   after `dayFraction: 0.5`?
6. Did a raid start near you and stop again?
7. Priority 2:
   - heal and `Rested`
   - a spawned Boar, then kill
   - tame a spawned Boar
   - a damaged piece repaired
   - smelter fill
   - crop grow
   - cartography-table reveal, after recording the map on the table once
   - pins
