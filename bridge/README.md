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
    Link.cs              link probe, simulation load and handover (POST /v1/sim/handover)
    HandoverPlan.cs      handover rules (pure .NET, unit-tested)
    MapData.cs           cartography-table blob codec (pure .NET, unit-tested)
  tests/                 xunit tests for MapData (`dotnet test bridge/tests`)
  k8s/test-server.yaml   throwaway crossplay test server (namespace skald-bridge-test)
  INTEGRATION.md         design notes for the agent, web UI and deploy side (implemented in Skald 0.8.0)
```

## Build

```sh
bridge/build.sh                   # fetches refs into bridge/refs/ on first run
GAME_REFS=/some/dir bridge/build.sh   # or point at a dir with the 8 DLLs below
```

The first run fetches the reference DLLs into `bridge/refs/` (gitignored), all
anonymously and without the 2.3 GB install:

- six files of the dedicated server (Steam app 896660, Linux depot 896661):
  `assembly_valheim`, `assembly_utils`, `Splatform`, `Newtonsoft.Json`,
  `UnityEngine` and `UnityEngine.CoreModule`, about 2 MB, through
  [DepotDownloader](https://github.com/SteamRE/DepotDownloader)'s anonymous
  login (its framework build, run by the .NET SDK, so it works the same on
  Linux, macOS and Apple Silicon)
- `BepInEx.dll` and `0Harmony.dll` (HarmonyX, which BepInEx ships and
  loads) from `denikson/BepInExPack_Valheim` 5.4.2351 on Thunderstore; the
  zip is checked against a sha256 pinned in `build.sh` (another
  `BEPINEX_PACK_VERSION` needs its own `BEPINEX_PACK_SHA256`)

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
| `SKALD_BRIDGE_TERRAIN` | `on` | `off` / `false` / `0`: the terrain routes answer 503, everything else keeps working |
| `SKALD_BRIDGE_TERRAIN_RATE` | `4` | Terrain tile requests per second (burst 8); more answer 429 |
| `SKALD_BRIDGE_TERRAIN_DUTY` | `50` | Percent of one core terrain sampling may use (5..100); the sampler sleeps between rows to stay under it |

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
| `GET /v1/players` | | `uid, name, platformId, userId, playfabId, position{x,y,z}, hasCharacter, health, maxHealth, link, sim` per connected player. Position comes from the character ZDO, falling back to the peer reference position. `link` (0.6.0+, null when unreadable): `transport` (`playfab`, `steam`, `tcp` or `other`, from the socket's type name; the agent passes `playfab` on as `crossplay` and `tcp` as `other`), `pingMs` and `pingMaxMs` (median and worst round trip over 10 s, see [Link and simulation load](#link-and-simulation-load)), `pingUnsure` (true while the round trip is not known, rather than guessed), `replyGapMaxS`, `queueBytes`, `outBps`, `inBps`. `sim` (0.6.0+): `owned`, `nearby`, `zones`. Cheap enough to poll every 2 s |
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
| `POST /v1/build/fill` | `player` or `at`, `radius`, optional `item` | The pre-0.3.0 command, kept for older panels: every station gets its first (or the requested) input plus fuel, fermenters get mead base |
| `POST /v1/build/fill-kilns` | `player` or `at`, `radius` | Charcoal kilns get their first input (wood) up to capacity with `RPC_AddOre`. Answers `kilns`, `skipped`, `full`, `unloaded` and `added` (item: stations) |
| `POST /v1/build/fill-smelters` | `player` or `at`, `radius`, `what` (`ore`, `both` (default) or `coal`), `ore` (an item `GET /v1/build/stations` lists, or `current`; not needed for `coal`) | `RPC_AddOre` with that ore and/or `RPC_AddFuel`, up to capacity. A station that does not take the ore gets nothing (`skipped`); with `current` each station gets the ore at the head of its queue, and one holding no ore gets only fuel (`both`) or nothing (`ore`). Answers `smelters`, `skipped`, `full`, `unloaded`, `added` and `fuel` |
| `POST /v1/build/fill-fermenters` | `player` or `at`, `radius`, `base` (a mead base `GET /v1/build/stations` lists) | `RPC_AddItem` with that base, once, on every empty fermenter. One still fermenting or holding mead to tap is left alone (`full`). Answers `fermenters`, `skipped`, `full`, `unloaded` and `added` (0.4.0+) |
| `POST /v1/build/refuel-fires` | `player` or `at`, `radius` (default 30; 50 before 0.6.0) | Every fire with a `Fireplace` component that a player built and could feed by hand (torches, sconces, campfires, hearths, braziers, lanterns, the hot tub: it has a fuel item, does not burn forever, the game lets it be refilled, and its ZDO has a `creator`) gets `RPC_SetFuelAmount` with its own `m_maxFuel`. Fires nobody built (Fuling camps, abandoned houses, dungeons; `world`) are never touched. One turned off (`state` not 1) is left off (`off`), and one whose fuel rounded up is already at the maximum is left alone (`full`), as the game does. At most 500 fires per call; `capped` says the call stopped there. The `Fireplace` values are read once per prefab. Answers `fires`, `full`, `off`, `world`, `unloaded`, `capped` and `byPrefab` (prefab: fires refuelled) (0.5.0+) |
| `GET /v1/build/stations` | | Every kiln and smelter prefab with the items it takes, in the game's order, read from the prefabs' `Smelter` components, and every fermenter with the mead bases its `Fermenter` component takes: `{kilns:[{prefab, inputs}], smelters:[{prefab, fuel, inputs}], fermenters:[{prefab, inputs}]}` (`fermenters` 0.4.0+). A kiln burns nothing and makes what a smelter burns; a smelter burns what a kiln makes. Windmills, spinning wheels and the eitr refinery are neither |
| `POST /v1/build/grow` | `player` or `at`, `radius` | Back-dates the plant time of crops and saplings |
| `GET /v1/tombstones` | | `id, owner, position, loaded` |
| `POST /v1/tombstones/move` | `id`, `player` or `at` | Moves a tombstone that no player has loaded |
| `POST /v1/map/reveal` | `player` or `at`, `radius` | Marks the whole map explored in the shared data of every cartography table in range. It decodes the table blob, merges the change (never replaces it), re-encodes and writes it back (layout in `plugin/MapData.cs`). A table nobody has written gets a fresh blob. An unknown blob version answers 409 and leaves the table untouched |
| `POST /v1/map/pins` | `pins: [{x, z, name, type: icon0..icon4}]`, `player` or `at`, `radius` | Merges shared pins into the tables in range. Pins carry the fixed owner id `0x534B414C44` ("SKALD") and skip duplicates (same name within 1 m) |
| `POST /v1/nearby` | `player` or `at`, `radius` | Counts objects by prefab, and how many are loaded. Read-only diagnostics |
| `POST /v1/containers/add` | `prefab` (e.g. `piece_chest_wood`), `at: {x, y, z}` (the chest's position in the save, within 0.5 m), `item`, `amount` (1-9999) | Puts items into one chest, through the game's own `Inventory`: tops up stacks of that item, then fills empty slots. Refuses with 409 when a player has the chest open or stands within reach of it, when there is no room (the message says how many fit), when two chests sit on the spot, or when the chest holds items the server does not know or that do not read back the same; 404 when the chest or the item is gone; 400 for carts, ships and graves. The server takes ownership and writes the `items` ZDO value, so a client that has the chest loaded reloads it within a second and gets ownership back within two; an unloaded chest just keeps the new items. Answers `slots: [{x, y, added, stack}]`, `room` (left), `loaded` and `position` |
| `POST /v1/sim/handover` | `player` | Hands the simulation of the area around a player to that player: every saved object in the area the game's ownership pass covers for them (the same scan as `sim`) that another connected player simulates now, and that nobody is using, gets them as owner. Skips objects not saved with the world (player characters, projectiles), objects outside the player's active area, objects with no owner, owned by the server or by a peer that left, objects in use (a ship being steered, a mount being ridden, an open chest, a cart in harness), items lying on the ground, and objects that hold or work items (chests, smelters and kilns, fermenters, beehives, cooking stations, item and armor stands, pickables, sap collectors, fires, shield generators, turrets, catapults, feasts, fish, ore deposits, animals that take a saddle, and carts and ships with storage, since their storage is a chest). Each moved object's data revision jumps ahead so late updates from the old owner cannot take it back. At most 5000 objects per call; `capped` says it stopped there. An object that fails is skipped and counted, and the rest still move. Answers `objects` (moved), `zones` (the zones they lie in), `fromPeers` (how many players they came from), `already` (the player simulated these already), `inUse`, `loose` and `kept` (left alone), `failed` and `capped`; never who they came from. See [Simulation handover](#simulation-handover) (0.7.0+) |

### Link and simulation load

In Valheim the client that owns an area simulates it for everyone near:
creatures, fires, carts, ships. One player on a bad line or a slow machine
makes the whole area stutter for the others while the server itself is idle.
`GET /v1/players` therefore reports, per player:

- `pingMs`, `pingMaxMs`: the round trip of the game's own keep-alive, median
  and worst over the last 10 s. `ZRpc` pings each peer once a second
  (`ZRpc.UpdatePing`) and the peer answers each one (`ZRpc.ReceivePing`
  with `false`). The plugin hooks both with Harmony and notes the time of
  every ping going out and every reply being handled, per connection. Each
  reply is paired with the oldest ping still unanswered. This rests on one
  assumption: the socket delivers every keep-alive, in order, so the n-th
  reply answers the n-th ping. Under it the pairing holds however many
  replies one frame handles (crossplay hands several to the game at once)
  and for round trips longer than the second between pings. The one known
  case that breaks the assumption on a live connection is
  `ZPlayFabSocket.ResetAll` (the remote restarted its session: the socket
  drops what it had in flight), and a third hook on it stops that player's
  pairing, so their ping shows as unknown until they reconnect. A drop the
  plugin cannot see would leave that player's ping reading a second or more
  high.
  The resolution is a frame (about 20 ms at 50 fps); on crossplay both the
  ping and the reply also pass through the socket's compression thread,
  which adds up to a frame or two, as it does for everything the game sends.
  The reply hook reads the ping's flag and puts the read position back, so
  the game reads the package unchanged; the ping hook only compares the
  game's private ping timer before and after. `pingUnsure` means the round
  trip is not known: no reply was timed in the window (a player who just
  joined, or a stall), the hooks are off, or one connection's pings were not
  all seen (a reply with no ping waiting, which a client can also cause by
  sending a stray reply, more pings unanswered than the game's 30 s timeout
  allows, or a crossplay session reset: that player's ping then stays unknown
  until they reconnect; the first such case logs one warning line). An unsure ping is no verdict of its own: the panel then judges
  the link by stalls and the send backlog. On Steam, the socket's own ping is
  used when `GetConnectionQuality` gives one.
- `replyGapMaxS`: the longest wait for a keep-alive reply in the last 10 s,
  from the reply times above (with the hooks off, from the game's public
  `GetTimeSinceLastPing()`, read once a frame). About 1 on a healthy link; it
  climbs while the link stalls (the game drops the peer at 30).
- `queueBytes`: `ISocket.GetSendQueueSize()`. On crossplay that is a quarter
  of the bytes sent and not yet acknowledged. `ZDOMan.SendZDOs` sends world
  updates only with 2048 of room under 10240, so above 8192 the game stops
  sending that player world updates until the queue drains. The agent
  rounds it down, so a backlog just under the limit never reads as over it.
- `outBps`, `inBps`: `ISocket.GetConnectionQuality`'s byte rates. On
  crossplay (`ZPlayFabSocket`, through `ZNetStats`) its ping and quality are
  always 0, so they are not used; on Steam it goes through the client
  networking API, and the first failure turns it off for that socket kind
  (one warning line). `GetCurrentSendRate` is
  never called: crossplay throws `NotImplementedException`.
- `sim`: the objects in the player's active area, found the way the game hands
  out ownership (`ZDOMan.ReleaseNearbyZDOS`: `FindSectorObjects` around the
  zone of the peer's reference position, near simulation distance only), with
  how many of them (all ZDOs, not only persistent ones) the player owns and in
  how many zones. One scan for everyone at most every 5 s, cached in between,
  on the main thread inside the request (the game runs the same search for
  every peer every 2 s). A failed scan is retried at the next one; only a
  broken binding after a game update turns it off.

Every one of these is optional: a game update that renames a member blanks
that value (one warning line) instead of failing `/v1/players`, which the
map's positions depend on. None of them is in the startup binding probe. The
keep-alive hooks are applied once at startup, inside a try: if a hooked
method or the private `m_pingTimer` is gone, patching fails, one warning line
says so, and only the round trip goes blank. The hook bodies catch
everything and never throw into the game; the first failure there unhooks
the round trip the same way. They record only on a server, and are removed
when the plugin unloads. The session-reset hook is optional on top: if it
cannot be applied, one warning line says so and the ping still works, only
without following resets. Once a frame the plugin also checks the hooks:
if the game keeps showing a recent reply (its own `GetTimeSinceLastPing()`)
that the reply hook never reported, or no ping is reported for a player for
more than 3 s although the game pings everyone once a second, for 10 s on
end (so that one long frame cannot trip it), the hooks are taken as not
firing, one warning line says so, and the round trip goes blank as if
patching had failed. The reply hook runs before any other mod's prefix
(`Priority.First`), so it reads the package where the game will.

### Simulation handover

`POST /v1/sim/handover` moves ZDO ownership on the server. What the game does
with ownership, read from the decompiled 1.0 assemblies (build l-1.0.20):

- **The ownership pass.** Only the server runs it (`ZDOMan.Update` ->
  `ReleaseZDOS`), every 2 s: `ReleaseNearbyZDOS` once with the server's own
  reference position and then once per peer in `m_peers`, each over
  `FindSectorObjects` around the zone of that peer's reference position with
  the near simulation distance. It skips every object that is not saved with
  the world (`!ZDO.Persistent`).
- **When it takes an object.** For a peer's turn: an object that peer owns is
  released (owner 0) once it lies outside the peer's active area
  (`ZNetScene.InActiveArea` around the peer's zone); an object someone else
  owns goes to the peer only when it has no owner or lies outside its current
  owner's active area, and lies inside the peer's. A "valid owner" is thus any
  connected peer (or the server) whose active area holds the object; there is
  no other test (no ping, no load, no platform).
- **Why a handover sticks.** The handover only moves objects inside the
  target's active area. On the next pass the old owner's turn finds an owner
  (the target) whose active area holds the object, so leaves it, and the
  target's own turn keeps it. When the target walks away the object falls
  outside their area, and the next peer whose turn comes and has it in range
  takes it, as the game would have done anyway.
- **How the change travels.** `ZDO.SetOwner` on the server bumps the object's
  owner revision and marks its sector dirty, so every peer in range gets the
  new owner with its next object update (`ZDOMan.SendZDOs`). A client that
  receives a higher owner revision takes the new owner even when its data is
  not newer (`RPC_ZDOData`). Each moved object is sent again to every peer in
  range, so one call moves at most 5000.
- **What is left alone, and why.** Objects not saved with the world: the
  pass never moves them, and the server destroys them as orphans when their
  owner leaves (`RemoveOrphanNonPersistentZDOS`), so a player character or an
  arrow must stay with its owner. Objects outside the target's active area:
  the target's own turn would release them within 2 s. Objects owned by the
  server or by a peer that left, or by nobody: the pass hands those out by
  itself. Objects in use, read from their saved values: a ship's helm or a
  saddle with a `user` (`ShipControlls`, `Sadle`: the owner grants control),
  a chest with `InUse` 1 (`Container`: the opener owns it while it is open and
  only the owner saves the inventory), a cart with `attachJoint` (`Vagon`).
  The game moves those only from the owner's own client, to the player using
  them. `attachJoint` is also a string a character's `ZSyncTransform` writes
  under the same hash, but `ZDO.GetBool` reads the int table only, so it never
  reads as a cart. Items on the ground (`ItemDrop` prefabs): a pickup, an
  auto-stack merge or a partial take asks the owner first
  (`RPC_RequestOwn`) and then writes or destroys the drop as owner, so moving
  the owner in the middle could let two clients act on one drop.
- **What holds or works items stays too.** The revision jump below drops the
  old owner's last writes to a moved object, and many owner-side item
  handlers record an item going in or out only in the object's data:
  `Smelter` spawns a bar and then shortens its queue (kilns, furnaces,
  windmills, spinning wheels and refineries are smelters too), the ore a
  player adds is taken from their inventory before the owner queues it, and
  `Pickable`, `Beehive`, `Fermenter`, `ItemStand`, `CookingStation`,
  `SapCollector` and a `Container` take-all work the same way. Dropping such a
  write could duplicate or lose an item, so objects whose prefab has one of
  these components are left with their owner (`kept`): `Container` (also in
  children: graves, cart and ship storage, the incinerator), `Smelter`,
  `Fermenter`, `Beehive`, `CookingStation`, `ItemStand`, `ArmorStand`,
  `Pickable`, `PickableItem`, `SapCollector`, `Fireplace` (fuel added by
  players), `ShieldGenerator` and `Turret` (fuel and ammo), `Catapult`,
  `Feast`, `Fish`, and `MineRock` / `MineRock5` (each mined area's health is
  data, and its drops spawn when it breaks). The components are looked up
  once per prefab. Not on the list: building pieces, trees and plain
  destructibles (their drops come with the object's destruction, which does
  not depend on revisions), and creatures (`Tameable`'s saddle is the one item
  write there, and only in the instant a saddle goes on). An object whose
  data revision is too near the 32-bit top to jump is kept as well.
- **Late updates from the old owner.** In `RPC_ZDOData` the server takes a
  client's object whole, owner included, when the client's data revision is
  newer than its own. The old owner keeps sending updates until it hears of
  the new owner. Without care, one sent just before the handover puts the old
  owner back on the server, while the old owner has already taken the new
  owner and stopped simulating (`ShouldSend` sees no change to send it back):
  nobody would simulate the object until the old owner leaves. So the
  handover moves the object's data revision 2^20 ahead together with the
  owner. That covers the old owner's window, its send backlog plus a round
  trip (seconds on a bad line), at the hundreds of revisions a second a
  moving object's sync writes. The late updates then fail the "newer" check, and their older owner
  revision is ignored too; the old owner gets the server's copy with a newer
  data revision and takes it, owner included. The revision is not saved with
  the world (`ZDO.Load` starts it at 0), and game code compares it only for
  "changed since" (`Container`, `ItemDrop`, `Door`, `ZSyncTransform`), so the
  jump costs one reload of the object on each client. The cost players see:
  the old owner's last changes to the moved objects (creatures, building
  pieces, a raft) are dropped, so a moving creature can snap back once. No
  item moves are lost, since what holds items is not moved: that includes
  carts and ships with storage and animals that take a saddle.

**Not verified on a live server.** All of the above is read from code. What
the code does not settle:

- **The revision jump in practice.** That the old owner steps down cleanly,
  and how visible the one snap back is. Check: with a working smelter and a
  tamed animal at the base, hand it over, wait 10 s, and both should still
  work (the smelter keeps smelting with its old owner, the animal moves and
  eats with the new one); compare both players' `sim.owned` over the same
  10 s.
- **Client-side handovers.** `Ship.UpdateOwner` on the owning client hands a
  ship with players aboard to one of them when the owner is not aboard. Only
  a raft can be moved (the other ships hold a chest and stay), and a raft
  carrying passengers goes back to a passenger. That is the game's own rule
  and is left to it.
- **The load itself.** Whether the new owner simulates the area more smoothly
  than the old one depends on their machine and line; the panel's link line
  is the only guide.

These answer `501` with the reason, because the state they touch lives only on
the client: `POST /v1/weather`, `/v1/player/feed`, `/v1/player/godmode`,
`/v1/player/fly`, `/v1/player/ghost` and `/v1/player/freebuild`.

### Terrain (read-only)

The live world generator, sampled the way the terrain Job samples it (same
calls, same reflection binding), for the agent's terrain tiles. Not audited,
not gated on the tested-build list: they change nothing.

| Method + path | Arguments | Does |
|---|---|---|
| `GET /v1/terrain/info` | | `seedHash`, `worldGenVersion` and `gameBuild` of the running world, `waterLevel`, the biome index order, `forest` (`mask`, `factor` or `none`), the limits, and `palette`: the game's own minimap colours by biome when the plugin could read them (`source` `instance` or `prefab`), else `{"source":"none"}` |
| `GET /v1/terrain/tile` | `x`, `z` (the north-west sample, metres), `step` (metres, 0.25..128), `n` (samples per edge, at most 260) | A binary grid, `application/octet-stream`: `"SKT1"`, version, flags, `n`, `x0`, `z0`, `step`, then `n*n` biome indices, `n*n` u16 heights (`(metres + 500) * 50`) and, with flag 1, `n*n` forest values 0..255. Layout in `plugin/TerrainTile.cs`. Headers `X-Skald-Sample-Ms` (sampling time), `X-Skald-Wall-Ms` (with the duty-cycle rests), `X-Skald-Seed-Hash`, `X-Skald-WorldGen-Version`, `X-Skald-Game-Build` |

Tiles never run on the game's main thread: they are sampled on the request's
own thread, one at a time (a second waits up to 3 s, then 429), at below-normal
priority, duty-cycled to `SKALD_BRIDGE_TERRAIN_DUTY` and abandoned after 20 s.
The game does the same: its `HeightmapBuilder` samples the world generator on
its own thread while the main thread runs. Only `/v1/terrain/info` touches the
main thread, once per process, to read the minimap colours (Unity objects).
503 means the world is not loaded yet, terrain is switched off, or a game
update broke the binding (one log line, the route stays off).

## Audit log

Each mutating command writes two lines to the server log: the arguments before
it runs, and the outcome after (`result=ok <response>`, `result=error <message>`,
`result=timeout` or `result=exception`). Both are written by BepInEx to stdout,
so `kubectl logs` and Loki see them. They are for people reading the log: the
agent builds the Saga's `admin` events from the commands it sends and the
replies it gets, not from these lines.

```
[Info   :Skald Bridge] [SkaldBridge] audit actor=test cmd=POST /v1/globalkeys/set args={"key":"nobuildcost"}
[Info   :Skald Bridge] [SkaldBridge] audit actor=test cmd=POST /v1/globalkeys/set result=ok {"ok":true,"data":["defeated_eikthyr","nobuildcost"]}
```

Read-only commands (`GET`, `/v1/nearby`) are not logged, also when they fail
(a busy terrain tile's 429, for example); a read that times out or throws gets
one `read <cmd> result=...` warning instead. The token is never logged.

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
  every case. The only Harmony patches are the two keep-alive hooks on `ZRpc`
  (see [Link and simulation load](#link-and-simulation-load)): they observe,
  never change what the game does, and turn themselves off on any error.
- **Token.** It is compared as constant-time SHA-256. Bodies over 64 KB are
  refused. Strings are length-capped.
- **Terrain.** Read-only, off the main thread, one tile at a time, rate-limited
  and duty-cycled (see [Terrain](#terrain-read-only)); its sampling buffers are
  reused, so a tile leaves one encoded answer behind for the collector.
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

**New in v0.2.0, not yet verified on a live server:** the terrain routes are
compiled against the 1.0 reference assemblies and their codec, limits, rate
limit and duty cycle are unit-tested, but sampling, the minimap forest mask on an
uninitialised `Minimap` and the palette lookup have not run against a loaded
world yet. Check after deploying: `GET /v1/terrain/info` answers, its `forest`
is `mask` and `palette.source` says whether the colours came from the game;
`X-Skald-Sample-Ms` on a 260 x 260 tile shows the real cost per tile.

**New in v0.7.0, not yet verified on a live server:** `POST /v1/sim/handover`.
It compiles against the 1.0 reference assemblies and its rules (what moves,
what is left alone, the counts, the 5000 cap and the data revision jump) are
unit-tested in `tests/HandoverPlanTests.cs`. How the game treats the new owner
is read from code only; see [Simulation handover](#simulation-handover) for
what is verified from code and what to check live:

- with two players at one base, hand it to the one who simulates less, then
  compare both players' `sim` over the next 10 s;
- with a working smelter and a tamed animal at the base, hand it over, wait
  10 s: both still work;
- walk the new owner away and see the area go back.

**New in v0.8.0, not yet verified on a live server:** the keep-alive hooks.
The pairing is exact as long as the socket delivers every keep-alive (see
above for the crossplay session reset) and is unit-tested in
`tests/LinkPlanTests.cs` (several replies in one frame, round trips stepping
up and down by more than a second, heavy jitter, a stall and its recovery,
peers joining while others have pings in flight, a session reset, hooks
that do not fire). Read from the decompiled
1.0 assemblies only: that `ZRpc.UpdatePing` and `ZRpc.ReceivePing` are not
inlined into `ZRpc.Update` by the server's runtime (if the reply hook never
fired, the cross-check above turns the round trip off after about 10 s, with
one warning line), and that the plugin loads
before the first player connects, so no ping goes out unseen. Check after
deploying with players on crossplay: `pingUnsure` gone within a few seconds
of each joining, and `pingMs` in the range 0.6.0 showed for the one player
it could pair (median about 150 ms, worst about 220 ms on that server).

**New in v0.6.0:** `link` and `sim` in `GET /v1/players`, and the refuel
default of 30 m. Seen live (2026.10.31, three players on crossplay):
`replyGapMaxS` about 1 to 1.2, `queueBytes` up to a few KB, `sim` plausible.
0.6.0 and 0.7.0 inferred the keep-alive from the game's timers once a frame
and could not see two replies handled in one frame: one ping stayed listed
for good and that player's ping read about a second high, or unsure for the
whole session (#202). 0.8.0 replaces that with the hooks above. Not yet seen
live: `ZSteamSocket.GetConnectionQuality` (client API, may fail on a
dedicated server), and that a player alone at a base owns most of its
objects.

**New in v0.5.0, not yet verified on a live server:** `build/refuel-fires`
compiles against the 1.0 reference assemblies, and which fires it takes and what
it leaves alone (not built by a player, unloaded, turned off, full) are
unit-tested in `tests/RefuelPlanTests.cs`. Not yet seen in
a loaded world: the `Fireplace` values of the real prefabs and the owning client
applying `RPC_SetFuelAmount` (stand next to a half-burnt torch, refuel it from the
panel, and its flame should grow at once).

**New in v0.4.0, not yet verified on a live server:** `build/fill-fermenters`
and the `fermenters` list in `build/stations` compile against the 1.0 reference
assemblies, and the rule (one base, only into an empty fermenter, only a base it
takes) is unit-tested in `tests/FillPlanTests.cs`. Not yet seen in a loaded
world: the fermenter list from the real prefabs and the empty check on
`s_content`. `RPC_AddItem` is sent as in the verified 0.1.x `build/fill`.

**Also new in v0.4.0, not yet verified on a live server:** `containers/add`
compiles against the 1.0 reference assemblies, and its room check and the
"only ever adds" check are unit-tested in `tests/ChestPlanTests.cs`. Not yet
seen in a loaded world: the round trip of a real chest through the game's
`Inventory` on the server, and a client that has the chest loaded picking up
the write (open the chest in game after adding; it should show the items
within a second, and stay openable).

**New in v0.3.0, not yet verified on a live server:** `build/fill-kilns`,
`build/fill-smelters` and `build/stations` compile against the 1.0 reference
assemblies, and the station rules (what counts as a kiln or a smelter, which
ore a station takes, keep-current, capacity) are unit-tested in
`tests/FillPlanTests.cs`. Not yet seen in a loaded world: the kiln and smelter
split from the real prefabs (check `GET /v1/build/stations`), the head of the
ore queue read from the ZDO for `ore: current`, and the fuel top-up from
`s_fuel`. `RPC_AddOre` and `RPC_AddFuel` are sent as in the verified 0.1.x
`build/fill`.
