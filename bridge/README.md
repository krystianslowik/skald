# Skald bridge

A server-side BepInEx 5 plugin for the Valheim 1.0 dedicated server. It gives the
Skald agent live admin commands (broadcast, save, kick/ban, time, raids, item and
creature spawns, teleport, global keys, and a few more) over HTTP on
`127.0.0.1` inside the game pod. The agent runs as a sidecar in the same pod
network namespace, so nothing is exposed outside the pod.

The plugin calls the operator's own installed game code through its public API.
It contains no game code. Game and BepInEx DLLs are needed to compile it, but
they are fetched at build time and never committed. Only `SkaldBridge.dll`
(under 100 KB) ships.

Verified against game builds `l-1.0.17` and `l-1.0.20`, BepInEx 5.4.23.5 (BepInExPack Valheim
5.4.2351), image `ghcr.io/community-valheim-tools/valheim-server:1.4.0`.

## Layout

```
bridge/
  build.sh               fetch reference DLLs if missing, build out/SkaldBridge.dll
  Dockerfile, install.sh the skald-bridge initContainer image
  plugin/                C# source + SkaldBridge.csproj (net472, BepInEx 5)
    Plugin.cs            lifecycle, kill switch, binding probe, main-thread queue, time freeze
    HttpServer.cs        loopback listener, token check, audit log, error mapping
    Commands.cs          route table + priority-1 commands
    Extras.cs            priority-2 commands
    MapData.cs           cartography-table blob codec (pure .NET, unit-tested)
  tests/                 xunit tests for MapData (`dotnet test bridge/tests`)
  k8s/test-server.yaml   throwaway crossplay test server (namespace skald-bridge-test)
  INTEGRATION.md         design notes for the agent, web UI and deploy side (implemented in Skald 0.8.0)
```

## Build

```sh
bridge/build.sh                   # fetches refs into bridge/refs/ on first run
GAME_REFS=/some/dir bridge/build.sh   # or point at a dir with the 7 DLLs below
```

The first run fetches the reference DLLs into `bridge/refs/` (gitignored), all
anonymously and without the 2.3 GB install:

- six files of the dedicated server (Steam app 896660, Linux depot 896661):
  `assembly_valheim`, `assembly_utils`, `Splatform`, `Newtonsoft.Json`,
  `UnityEngine` and `UnityEngine.CoreModule`, about 2 MB, through
  [DepotDownloader](https://github.com/SteamRE/DepotDownloader)'s anonymous
  login (its framework build, run by the .NET SDK, so it works the same on
  Linux, macOS and Apple Silicon)
- `BepInEx.dll` from `denikson/BepInExPack_Valheim` 5.4.2351 on Thunderstore

The game assemblies are not on NuGet in a current version (the BepInEx feed's
`Valheim.GameLibs` stops at 0.202.14), and the plugin calls them directly, so
the terrain plugin's NuGet-only build does not apply. Needs curl, unzip and the
.NET SDK (8 or later; the target is `net472` through the
`Microsoft.NETFramework.ReferenceAssemblies` package, so no Mono is needed).

The target is `net472`, not `net462`. The game assemblies reference
`netstandard`, and net472 ships netstandard support built in. net462 builds too,
but it drags in about 100 facade DLLs and MSB3277 warnings. Unity's Mono runs
either.

`SKALD_TEST=1 bridge/build.sh` adds `POST /v1/debug/spawn-prefab`, which places
any prefab (a cartography table, a tombstone) so those commands can be
exercised without a player. Release builds never contain it.

## Install

Copy `SkaldBridge.dll` into `/config/bepinex/plugins/` before the server starts
and set `BEPINEX=true`. The image syncs that directory into its BepInEx install on
every start.

The image `ghcr.io/krystianslowik/skald-bridge` (`bridge/Dockerfile`, busybox
plus the DLL and `install.sh`) does this as an initContainer: it deletes any old
copy from `/config/bepinex/plugins` and from the BepInEx install (the image's
sync never removes files), then copies the new one in. With `SKALD_BRIDGE=off`
in the initContainer's own environment it only removes. The Skald deploy
examples use it (`deploy/kubernetes/bridge`, the Compose profile `bridge`).

`k8s/test-server.yaml` copies the DLL from a ConfigMap instead:

```sh
kubectl -n skald-bridge-test create configmap skald-bridge-plugin \
  --from-file=SkaldBridge.dll=bridge/out/SkaldBridge.dll --dry-run=client -o yaml | kubectl apply -f -
kubectl -n skald-bridge-test create secret generic skald-bridge \
  --from-literal=SKALD_BRIDGE_TOKEN="$(openssl rand -hex 24)"
kubectl apply -f bridge/k8s/test-server.yaml
```

Success looks like this in the server log:

```
[Info   :Skald Bridge] [SkaldBridge] loaded v0.1.1, listening on 127.0.0.1:9010, game build l-1.0.17
```

## Configuration (environment of the game container)

| Variable | Default | Meaning |
|---|---|---|
| `SKALD_BRIDGE` | `on` | `off` / `false` / `0`: the plugin loads, logs one line and serves nothing (kill switch) |
| `SKALD_BRIDGE_TOKEN` | none | Shared secret, 16 characters or more. If it is missing or short the plugin serves nothing |
| `SKALD_BRIDGE_PORT` | `9010` | Loopback port |

## API

Every request needs the header `X-Skald-Token: <token>`. It may carry
`X-Skald-Actor: <who>`, which is recorded in the audit line (letters, digits,
`-_.@`, at most 64 characters). Bodies are JSON objects. **Always send a body on
POST, `{}` at minimum.** Mono's HttpListener answers 411 to a POST without
Content-Length. Query-string parameters are merged into the arguments, so simple
GETs can use `?player=...`.

Responses are `{"ok":true,"data":...}`, or `{"ok":false,"error":"..."}` with the
following statuses:

- 400: bad arguments
- 401: bad token
- 404: unknown player, item or event
- 409: conflicting state
- 501: not possible server-side
- 503: world not loaded yet, or the bridge or command was disabled
- 504: the game's main thread did not run the command within 5 s

`player` arguments accept any of these:
- the peer uid
- the platform user id as the game shows it (`Steam_…`, `Xbox_…`, …)
- the socket host name
- the PlayFab id
- the character name (case-insensitive, must be unique)

Commands that act at a place take either `player` or `at: {x, z[, y]}`. Without
`y`, the generated terrain height is used, never below the water line.

### Priority 1

| Method + path | Body | Does |
|---|---|---|
| `GET /v1/health` | | Plugin version, game build, world loaded, frozen time, which game singletons exist |
| `GET /v1/players` | | `uid, name, platformId, userId, playfabId, position{x,y,z}, hasCharacter, health, maxHealth` per connected player. Position comes from the character ZDO, falling back to the peer reference position. Cheap enough to poll every 2 s |
| `POST /v1/broadcast` | `text`, `type`: `center` (default) / `topleft` / `narrator` | Sends the game's `ShowMessage` routed RPC to everybody. `narrator` is a center message in gold italics, using TMP rich text with the text inside `<noparse>`. `chat` answers 501: the Xbox client did not show a shout sent from the server, which has no sender platform id |
| `POST /v1/save` | | `ZNet.Save`. The log shows `World save (5/5) done` |
| `POST /v1/kick` | `player` | `ZNet.Kick` with the player's platform id |
| `GET /v1/bans` | | The game's ban list |
| `POST /v1/ban` | `player` (connected), or a platform id for an offline player | `ZNet.Ban`. Writes the game's own `bannedlist.txt` |
| `POST /v1/unban` | `player` = an entry on the ban list | `ZNet.Unban` |
| `GET /v1/time` | | `day, dayFraction, netTimeSeconds, dayLengthSeconds, timeSkipping` |
| `POST /v1/time/skip-to-morning` | | `EnvMan.SkipToMorning`, the same fast-forward as sleeping |
| `POST /v1/time` | `dayFraction` in [0,1): 0.25 is morning, 0.5 noon | Sets net time, forward only (to the next day if the fraction has already passed today) |
| `GET /v1/events` | | Current random event and the names that can be started |
| `POST /v1/events/stop` | | `RandEventSystem.ResetRandomEvent` |
| `POST /v1/events/start` | `name`, `player` or `at` | `RandEventSystem.SetRandomEventByName` at that position |
| `POST /v1/spawn` | `item`, `amount` (1-999), `quality` (1-10, capped at the item's max), or a kit: `items: [{item, amount, quality}, …]` (at most 20 lines, 60 stacks); `player` or `at` | Instantiates the item prefabs as drops next to the target, split into max-size stacks. The kit is validated before anything drops |
| `POST /v1/teleport` | `player` plus one of `toPlayer`, `to: {x, z[, y]}`, `toSpot` | Sends `RPC_TeleportPlayer` to the player's client with distantTeleport, like a portal. `toSpot` is a world location closest to the player: an alias (`spawn, eikthyr, elder, bonemass, moder, yagluth, queen, fader, haldor, hildir, bogwitch`) or any location prefab name |
| `GET /v1/locations` | | The aliases plus the location prefab names in this world |
| `GET /v1/globalkeys` | | Global keys |
| `POST /v1/globalkeys/set` | `key` | e.g. `defeated_eikthyr`, `nobuildcost` |
| `POST /v1/globalkeys/remove` | `key` | |

### Priority 2

Objects near a player are simulated by that player's client, so these commands
send the game's own per-object RPC to the owning client. Objects that nobody has
loaded are counted as `unloaded` and skipped. `radius` is at most 100 m.

| Method + path | Body | Does |
|---|---|---|
| `POST /v1/time/freeze`, `POST /v1/time/resume` | | Pins net time every frame. Day and night stop, and so does every timer keyed on net time (smelters, crops, respawns). The freeze is not kept across a server restart |
| `POST /v1/creatures/spawn` | `prefab` (e.g. `Boar`, `Troll`, `Eikthyr`), `count` 1-20, `level` 1-10 (stars + 1), `tamed`; `player` or `at` | Instantiates creatures near the target |
| `POST /v1/creatures/kill` | `player` or `at`, `radius` (default 30), `includeBosses` | Sends `RPC_Damage` (1e7 true damage) to every loaded creature in range. Never hits players or tames. Bosses are hit only with `includeBosses`. Drops fall as on a normal kill |
| `POST /v1/creatures/tame` | `player` or `at`, `radius` (default 10) | `RPC_SetTamed(true)` on tameable creatures |
| `POST /v1/player/heal` | `player`, `amount` (default full) | `RPC_Heal` on the player's character |
| `POST /v1/player/status` | `player`, `effect` (e.g. `Rested`) | `RPC_AddStatusEffect` on the player's character |
| `POST /v1/build/repair` | `player` or `at`, `radius` | `RPC_Repair` on damaged pieces |
| `POST /v1/build/fill` | `player` or `at`, `radius`, optional `item` | `RPC_AddOre` up to capacity plus `RPC_AddFuel` for smelters, kilns and furnaces; `RPC_AddItem` for fermenters |
| `POST /v1/build/grow` | `player` or `at`, `radius` | Back-dates the plant time of crops and saplings |
| `GET /v1/tombstones` | | `id, owner, position, loaded` |
| `POST /v1/tombstones/move` | `id`, `player` or `at` | Moves a tombstone that no player has loaded |
| `POST /v1/map/reveal` | `player` or `at`, `radius` | Marks the whole map explored in the shared data of every cartography table in range. It decodes the table blob, merges the change (never replaces it), re-encodes and writes it back (layout in `plugin/MapData.cs`). A table nobody has written gets a fresh blob. An unknown blob version answers 409 and leaves the table untouched |
| `POST /v1/map/pins` | `pins: [{x, z, name, type: icon0..icon4}]`, `player` or `at`, `radius` | Merges shared pins into the tables in range. Pins carry the fixed owner id `0x534B414C44` ("SKALD") and skip duplicates (same name within 1 m) |
| `POST /v1/nearby` | `player` or `at`, `radius` | Counts objects by prefab, and how many are loaded. Read-only diagnostics |

These answer `501` with the reason, because the state they touch lives only on
the client: `POST /v1/weather`, `/v1/player/feed`, `/v1/player/godmode`,
`/v1/player/fly`, `/v1/player/ghost` and `/v1/player/freebuild`.

## Audit log

Each mutating command writes two lines to the server log: the arguments before
it runs, and the outcome after (`result=ok <response>`, `result=error <message>`,
`result=timeout` or `result=exception`). Both are written by BepInEx to stdout,
so `kubectl logs` and the agent's syslog feed see them:

```
[Info   :Skald Bridge] [SkaldBridge] audit actor=test cmd=POST /v1/globalkeys/set args={"key":"nobuildcost"}
[Info   :Skald Bridge] [SkaldBridge] audit actor=test cmd=POST /v1/globalkeys/set result=ok {"ok":true,"data":["defeated_eikthyr","nobuildcost"]}
```

Read-only commands (`GET`, `/v1/nearby`) are not logged. The token is never
logged.

## Safety

- **Loopback only.** The listener prefix is the literal `http://127.0.0.1:<port>/`.
  The plugin makes no outbound connections.
- **Kill switch.** With `SKALD_BRIDGE=off`, or a missing token, the plugin
  logs one line and opens no socket.
- **Main thread.** Every game call is queued and run in the plugin's `Update()`:
  at most 16 commands and 20 ms per frame. Each request waits at most 5 s. A
  command the game loop has not started by then is dropped, so it never runs
  late.
- **Game patches.** On startup the plugin probes the public members the core
  commands use. If any is missing it logs one line,
  `[SkaldBridge] disabled: game API binding failed (Type.member), game build …`,
  and serves only 503s. A `MissingMember`/`TypeLoad` error inside a command
  turns off just that command, with one log line. The game keeps running in
  every case. No Harmony patches are used.
- **Token.** It is compared as constant-time SHA-256. Bodies over 64 KB are
  refused. Strings are length-capped.
- **Bounds.** Coordinates must lie within ±10500. Radius is at most 100 m,
  spawns at most 60 stacks or 20 creatures, and time only moves forward.

## Known limits

- Server-owned objects, for example items or creatures spawned at a position no
  player is near, exist as ZDOs only. They materialise when a player arrives,
  and the owner-RPC commands treat them as `unloaded`.
- The dedicated server pauses net time while no player is connected, so time
  commands visibly move only with someone online.

## Test server

`k8s/test-server.yaml` is a throwaway crossplay server in its own namespace
(`skald-bridge-test`): a new world `SkaldBridgeTest`, password `change-me-test`,
`SERVER_PUBLIC=false`, `CROSSPLAY=true`, `BEPINEX=true`, emptyDir volumes, on a
`memory-tier=high` node. It has no ingress, and its egress matches the real
server's (DNS, TCP 80/443, public UDP 1024-65535). The join code is in the log:

```sh
kubectl -n skald-bridge-test logs deploy/valheim -c valheim | grep 'join code'
```

Call the plugin from inside the pod, either with the game container's own curl
or from an ephemeral container that shares the pod network:

```sh
kubectl -n skald-bridge-test exec deploy/valheim -c valheim -- sh -c \
  'curl -s -H "X-Skald-Token: $SKALD_BRIDGE_TOKEN" -H "X-Skald-Actor: me" \
   -d "{\"text\":\"hello\",\"type\":\"narrator\"}" http://127.0.0.1:9010/v1/broadcast'

kubectl -n skald-bridge-test debug <pod> --profile=general --image=curlimages/curl:8.10.1 \
  -- curl -s -H "X-Skald-Token: <token>" http://127.0.0.1:9010/v1/players
```

To iterate on the plugin without a full pod restart:
1. Copy the DLL into both `/config/bepinex/plugins/` and
   `/opt/valheim/bepinex/BepInEx/plugins/`.
2. Run `supervisorctl restart valheim-server`.

The world survives this. A pod restart creates a new world and downloads the game again.

Delete everything with `kubectl delete ns skald-bridge-test`.

## Verification status (l-1.0.17, 2026-10-10)

The test server was run with plugin v0.1.0. An Xbox player then
joined over crossplay with BepInEx loaded.

**Confirmed on an Xbox client:**
- joining a BepInEx server through crossplay
- players list (positions, health)
- broadcast `center` and `narrator`
- spawning items and kits, including quality
- teleport `toSpot` (Eikthyrnir)
- set time (evening, then noon)
- raid start near the player, then stop
- `creatures/kill`: 4 killed (Boar x3, Deer)
- `player/heal`
- `player/status` `Rested`
- `creatures/spawn`: a Troll, and a Wolf with `tamed:true`
- `creatures/tame`
- `build/fill`: a charcoal kiln filled
- `build/repair`: 2 pieces repaired

**Changed in v0.1.1** (the plugin in Skald 0.8.0's `skald-bridge` image):
- `broadcast type=chat` was accepted, but the Xbox player never saw it. It now
  answers 501 with the reason.
- `map/reveal` and `map/pins` threw a NullReferenceException even on a table the
  player had written: the dedicated server's Minimap is never initialised. Both
  now edit the table blob directly through `MapData` and merge with the
  existing data. Unit tests cover:
  - encode/decode round trip
  - the documented byte layout
  - reveal and pin merges
  - duplicate pins
  - version and truncation guards
  - a byte-exact round trip of a real table blob, through the opt-in
    `SKALD_MAP_BLOB` test
- `creatures/tame` returned `tamed:0` in the Xbox session. It could not be
  reproduced: later, two loaded boars near the player were tamed (`tamed:2`),
  and a repeat call skipped them because their ZDO `tamed` flag was set. The
  likely cause is that the boar was spawned 0.4 m from the freshly tamed Wolf
  and was killed before the call. The response now also reports `alreadyTamed`.

**Verified on the server only:**
- save: the log shows `World save (5/5) done`
- global keys list/set/remove round-trip
- skip-to-morning
- ban/unban of an offline platform id, with `bannedlist` updated
- kick of an unknown player gives 404
- tombstone move of a server-owned tombstone
- time freeze/resume
- kill switch: one log line, nothing listening
- 401/404/411/501 error paths
- initContainer + ConfigMap delivery

**Still to confirm with a player:**
- kick or ban of a connected player: the Xbox id appears as
  `Xbox_<digits>`, both as `platformId` and as `userId`
- teleport `to` coordinates and `toPlayer`
- `build/grow`
- `map/reveal` and `map/pins` with v0.1.1

**Not possible server-side (answers 501):**
- weather: clients pick their environment
- feeding: food lives in the client profile
- chat lines: see above
- god mode, fly, ghost, per-player free build: local client debug flags.
  The world-wide alternative is the `nobuildcost` global key.
