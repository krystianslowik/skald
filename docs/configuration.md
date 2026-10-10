# Configuration

## skald-agent

| Variable | Default | Description |
|---|---|---|
| `AGENT_TOKEN` | (required) | Shared secret; sent by the web tier as `X-Agent-Token` |
| `LISTEN_ADDR` | `:8080` | API listener (token-protected) |
| `METRICS_ADDR` | `:9464` | Prometheus listener (no token; restrict it with a NetworkPolicy or firewall) |
| `SYSLOG_ADDR` | `127.0.0.1:5140` | UDP address the game's syslogd forwards to |
| `SUPERVISOR_URL` | `http://127.0.0.1:9001/RPC2` | supervisord XML-RPC endpoint |
| `SUPERVISOR_USER` | (empty) | supervisord user (`admin` in the image) |
| `SUPERVISOR_PASS` | (empty) | Must match the game container's `SUPERVISOR_HTTP_PASS` |
| `CONFIG_DIR` | `/config` | The game's config volume, mounted read-only |
| `STATUS_FILE` | `/var/run/valheim/valheim-server.status` | The image's status file |
| `WORLD_NAME` | (empty) | Must match the game's `WORLD_NAME` |
| `SERVER_NAME` | (empty) | Shown in the header and page title; seeds the server settings |
| `SERVER_ARGS` | (empty) | The game's `SERVER_ARGS`; shown as modifier chips; seeds the server settings |
| `SERVER_PUBLIC` | (empty = public) | The game's `SERVER_PUBLIC` (`true`/`false`/`1`/`0`); seeds the server settings |
| `SETTINGS_DIR` | `/settings` | Where server settings are written (`server.json`, `server.env`). The feature is off (API 404, UI hidden) unless this directory exists and the agent can write to it |
| `PASSWORD_FILE` | (empty) | The game's server password secret, mounted read-only; seeds the password shown on the dashboard before the first save |
| `MAP_SHOW_NAMES` | `true` | Put grave and bed owners' names, portal tags and pin names on the world map. Platform ids (tag and pin authors, owner ids) are never sent either way. The map is behind the panel password, so this is on by default |
| `ICONS_DIR` | (empty) | Where the opt-in `skald-icons` sidecar writes the item icon sheet (`/config/skald-icons` in Kubernetes, `/icons` in Compose). Empty turns the icon routes off; see [Item icons](#item-icons) |
| `TERRAIN_DIR` | (empty) | Where terrain runs leave the world generator's grids (`/terrain`); empty turns the terrain image off. See [Terrain](#terrain) |
| `BRIDGE_URL` | `http://127.0.0.1:9010` | The Skald bridge plugin inside the game process; the agent shares the pod's (or container's) network namespace, so loopback reaches it. See [Admin bridge](#admin-bridge) |
| `BRIDGE_TOKEN` | (empty) | Same value as the game container's `SKALD_BRIDGE_TOKEN` (16+ characters). Empty leaves the `/bridge` routes unregistered and the admin UI hidden |
| `BRIDGE_TESTED_BUILDS` | `l-1.0.17` | Game builds admin commands may run on without a confirmation from the panel, comma-separated; `*` allows any |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## skald-web

| Variable | Default | Description |
|---|---|---|
| `AGENT_URL` | (required) | e.g. `http://valheim:8080` (Compose) or `http://skald-agent.valheim.svc.cluster.local:8080` |
| `AGENT_TOKEN` | (required) | Same value as the agent's |
| `PANEL_PASSWORD_HASH` | (required) | argon2id hash; generate with `skald-web hash-password` |
| `ADMIN_PASSWORD_HASH` | (empty) | Optional argon2id hash of an admin password (same command). Set, the panel password only views: admin commands, restarts, backups/updates and saving settings need an admin session, unlocked with this password and ended after 30 minutes without an admin action. Empty, everyone signed in is an admin, as before 0.8.0. See [Roles](#roles) |
| `SESSION_SECRET` | (required) | HMAC key for session cookies; 32+ random bytes |
| `SKALD_LOCALE` | `en` | Default UI language, `en` or `pl`; each viewer can switch in the header |
| `SKALD_TZ` | `$TZ`, else `UTC` | IANA zone for calendar days: streaks, daily playtime, the night-owl badge |
| `COOKIE_SECURE` | `true` | Secure flag on the session cookie; `false` only for plain-http setups |
| `TRUSTED_IP_HEADER` | (empty) | Header with the real client IP behind a proxy (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`); empty uses the socket address |
| `PROM_URL` | (empty) | Prometheus base URL; empty turns the resource charts off |
| `PROM_NAMESPACE` | `$POD_NAMESPACE`, else `valheim` | Namespace label in the cAdvisor queries |
| `PROM_CONTAINER` | `valheim` | Container label of the game server |
| `PROM_POD_REGEX` | `valheim-[a-z0-9]+-[a-z0-9]+` | Pod regex for the network series (anchored by PromQL) |
| `DB_PATH` | `/data/skald.db` | SQLite file for the event history |
| `BIND` | `0.0.0.0:8080` | Listen address |
| `WEB_ROOT` | `../web/dist` | Built SPA, relative to the working directory |
| `MAP_SPOILERS` | `false` | `true` shows every boss altar, trader and dungeon of the seed on the world map. Off, only places someone has been to are sent to the browser |
| `MOCK_AGENT` | (unset) | `1` runs against a built-in fake server (development) |

The resource charts query cAdvisor series as kube-prometheus-stack scrapes
them (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`,
`container_network_*_bytes_total`). Outside Kubernetes, point `PROM_*` at
whatever labels your cAdvisor uses, or leave `PROM_URL` empty.

## Server settings

The dashboard can change the server name, password, public listing, world
modifiers (`-preset`, `-modifier`, `-setkey`) and save interval. Only the
launch options in [Iron Gate's dedicated server guide](https://valheimgame.com/support/a-guide-to-dedicated-servers/)
are accepted, from structured input; nothing typed reaches the command line.
Other `SERVER_ARGS` tokens (`-crossplay`, `-backups 4`, ...) are kept as they
are and shown read-only.

How it fits together:

1. The agent writes `server.json` (the source of truth) and `server.env` to
   `SETTINGS_DIR`, atomically. Until the first save it shows the game's own
   environment (`SERVER_NAME`, `SERVER_PUBLIC`, `SERVER_ARGS`, `PASSWORD_FILE`),
   so the first save changes only what you change.
2. The game mounts the same directory read-only at `/settings` and gets
   `PRE_SERVER_RUN_HOOK` from [`deploy/settings/pre-server-run-hook.sh`](../deploy/settings/pre-server-run-hook.sh).
   The image runs it right before every server start. It reads four keys from
   `server.env` with an allow-list and never sources or evaluates the file.
3. Saved settings are pending until the server process restarts: from the
   dashboard right away (kicks everyone, may change the join code) or
   automatically once nobody has been online for a minute.

After the first save, `SERVER_NAME`, `SERVER_PASS`/`SERVER_PASS_FILE`,
`SERVER_PUBLIC` and `SERVER_ARGS` on the game container are only the starting
values: the dashboard's file wins on every start. The settings directory holds
the server password in plain text, readable by the agent and the game.

If the dashboard says the game did not confirm reading the settings, the hook
is missing or changed on the game container.

**Compose** ([`docker-compose.yaml`](../deploy/compose/docker-compose.yaml)): a
`skald-settings` volume, read-write in the agent and read-only in the game; a
one-shot `settings-init` (busybox) hands it to the agent's user (65532); the
server password is a Compose secret made from `SERVER_PASS` in `.env`, mounted
in both containers (`SERVER_PASS_FILE` and `PASSWORD_FILE`). In the Compose
file every `$` of the hook is doubled.

**Kubernetes** ([`valheim.yaml`](../deploy/kubernetes/valheim.yaml)): the
settings live on the `valheim-config` PVC under `skald/`.

- Pod: a `settings-init` initContainer (busybox, first in the list) runs
  `mkdir -p /config/skald && chown 65532:65532 /config/skald && chmod 0755 /config/skald`.
- Agent: `SETTINGS_DIR=/settings`, `PASSWORD_FILE=/secrets/server-pass`,
  `SERVER_PUBLIC` next to `SERVER_NAME`/`SERVER_ARGS`; mounts the PVC with
  `subPath: skald` read-write at `/settings`, and the server password Secret at
  `/secrets` with `defaultMode: 0444` (a second volume of the same Secret; the
  agent runs as 65532 and cannot read the game's root-only 0400 copy).
- Game: `PRE_SERVER_RUN_HOOK` (verbatim from the hook file),
  `PRE_SUPERVISOR_HOOK="chown -R 65532:65532 /config/skald && chmod 0755 /config/skald"`,
  and the same `subPath: skald` mounted read-only at `/settings`. The second
  hook matters: the image chowns all of `/config` to its own user every time
  the container starts, which would lock the agent out of `skald/`.

## Kubernetes notes

- **Native sidecars need Kubernetes 1.29+** (`initContainers` with
  `restartPolicy: Always`). The agent starts before the game, so it sees the
  very first log lines, and it can restart on its own without taking the game
  down.
- The `skald-agent` Service uses a **numeric `targetPort`**: named ports
  declared on native-sidecar containers are not resolved into EndpointSlices.
- No CPU limit on the game container on purpose: the game loop is
  single-threaded and CFS throttling shows up as rubber-banding.
- Exposing `skald-web` is up to you: an Ingress or Gateway with TLS, or a tunnel
  (Cloudflare Tunnel, Tailscale, ...) pointing at `skald-web:8080`. Set
  `TRUSTED_IP_HEADER` to the header your proxy uses so the login rate limit sees
  real client addresses, and narrow the `skald-web` NetworkPolicy ingress rule to
  the proxy's namespace.

## World map

The agent builds the map from the newest finished save (`_main.N.ok`) in
`CONFIG_DIR/worlds_local/WORLD_NAME`, at most once a minute and only after a
new save. It reads:

- the chunk files (`*.chunk`, Valheim 1.0), indexed by `_main.N.chunks`. Only
  chunks whose revision changed are parsed again; a chunk that does not parse
  keeps its last good contents. Land and water come from where objects are:
  a 64 m zone the world generated without objects is open water.
- every cartography table's explored area and shared pins. Without a table
  the map has no fog.
- portals (paired by their connection, else by a tag exactly two share),
  graves, beds, ships and carts, bases (zones with built pieces that touch),
  terrain edits, and the seed's locations from the `.db2`.
- what is in the chests, carts and ships players built (pieces that carry a
  creator), and in graves. Chests the world generated (treasure, shipwreck
  and dungeon chests) are never read, so neither they nor their loot show
  up anywhere. Crafter names follow `MAP_SHOW_NAMES`; crafter ids are never
  read. An inventory in a layout the agent does not know is shown as
  unreadable rather than guessed at.

On the real 1.0 world used to work out the format (about 376,000 objects
in 35 chunks) a full build takes about 0.04 s and 22 MB of allocations, and
the map is 26 KB gzipped (30 KB with the 47 containers and their items).

Spoilers: the agent marks a location explored when it is inside the
explored area or within 64 m of a built piece. The web tier drops everything
else unless `MAP_SPOILERS=true`. The seed alone tells where every boss is, so
this is off by default.

With a [terrain run](#terrain), the map's land comes from the game's own
world generator instead. The Terrain tab embeds [valheim-map.world](https://valheim-map.world/), a
third-party site, for the seed's terrain. It loads only when that tab is
opened; the "Open on full map" links in the map's popovers go there too,
centred on the point (`offset=x,z`, `zoom=0.100`, `ver=1.0.7`).

## Item icons

Opt-in. Off, the storage views draw a small category mark for each item
(logs, ore, an ingot, a sword, ...). On, they show each item's own icon.

> Skald ships no game assets: no icons, textures or item art in the
> repository, the images or any download. The `skald-icons` sidecar reads
> **your own installed** Valheim dedicated server files, read-only, and writes
> a sprite sheet to **your own** volume. Only the agent serves it, behind the
> agent token, and the web tier only to signed-in viewers. Skald is not
> affiliated with, endorsed by, or sponsored by Iron Gate Studio or Coffee
> Stain; Valheim is a trademark of its owners. Turn this on only if your
> panel is private to your community.

How it works:

- `skald-icons` (Python, UnityPy) reads the game's asset bundles under
  `/opt/valheim` (`server/`, else `bepinex/`; never the steamcmd download
  directory). Every item prefab's ItemDrop component names its inventory
  icon; the extractor follows that reference, so no names are guessed. The
  ~750 MB item bundle is read block by block: about 100 MB of it is touched.
- Output, in `ICONS_DIR`: `sheet.<build>.webp` (64 px cells, about 1.3 MB for
  ~1,000 items) and `map.json` (item prefab -> cell), written atomically,
  `map.json` last. `<build>` is a hash of the game's SoftRef manifest and the
  bundle sizes.
- It checks every 10 minutes. An unchanged build costs a few `stat()` calls;
  after a game update (the image updates in place) it rebuilds once, in a
  child process at `nice 19`: about 20 s of one core and ~550 MiB at its
  peak. A read that overlaps an update is thrown away and retried.
- The agent serves `GET /icons/map.json` and `GET /icons/sheet.webp` with
  the build as ETag (the sheet is immutable), and `/state` carries
  `icons: {available, build, count}`. The web tier proxies them as
  `/api/icons/*`. The browser loads the sheet once per game build.
- Exit codes of a single run (`--every 0`): 0 done or already current, 2 no
  game install found, 3 the game files could not be read (mid-update or an
  unknown format; the previous sheet stays), 4 the output is not writable,
  5 nothing to extract.

**Compose**: set `COMPOSE_PROFILES=icons` in `.env` and `docker compose up -d`.
The `icons` service mounts `valheim-data` read-only and the `skald-icons`
volume read-write; the agent mounts `skald-icons` read-only with
`ICONS_DIR=/icons`.

**Kubernetes**: enable the `icons` component in
[`kustomization.yaml`](../deploy/kubernetes/kustomization.yaml). It patches
the game pod ([`icons/sidecar.yaml`](../deploy/kubernetes/icons/sidecar.yaml)):

- an `icons` container (uid 65532, read-only root, limits 1 CPU / 1 GiB)
  mounting the `data` volume read-only at `/opt/valheim` and the config PVC
  with `subPath: skald-icons` at `/icons`;
- `settings-init` also creates `skald-icons/` and hands it to 65532, and
  `PRE_SUPERVISOR_HOOK` hands it back after the image's start-up `chown`, as
  for `skald/`;
- `ICONS_DIR=/config/skald-icons` on the agent, which already mounts `/config`
  read-only.

It changes the game pod, so applying it restarts the server once.

## Terrain

Opt-in. Off, the map inks land and sea from the save's 64 m zones. On, it
draws the land the game itself generates for the world's seed: biomes,
relief and water depth at about 10 m per pixel, multiplied into the
parchment, under the explored fog, and cut to the zones the world has
generated unless `MAP_SPOILERS=true`.

How it works:

- A **terrain run** is the community server image, unchanged, with
  `BEPINEX=true`. `run.sh` (from the `skald-terrain` image) starts the
  image's own bootstrap, which installs the dedicated server and BepInEx as
  usual; the image's `PRE_SERVER_RUN_HOOK` then runs the server binary once
  with Skald's plugin, which builds the world generator for the seed, samples
  biome and height on a grid (about 2 s for the generator and 1 to 4 s of
  sampling), writes the grids and quits; the hook stops supervisord before
  the real server would start. Nothing listens, no world is created, nothing
  is sent to Steam or PlayFab. If BepInEx does not load, a timeout
  (`SKALD_TERRAIN_TIMEOUT`, 180 s) stops the process.
- The plugin binds to the game by reflection, so it compiles without any
  game files (BepInEx and Unity reference assemblies from the BepInEx NuGet
  feed). Nothing from the game is in this repository or the images; BepInEx
  (LGPL-2.1) is installed by the community image at run time, not shipped.
- What to sample: with `SKALD_AGENT_URL` and `SKALD_AGENT_TOKEN`, the run
  reads the agent's `/state` `terrain.request` (seed name, seed hash and
  world generator version from the save's `.fwl2`) and exits at once when
  the agent's terrain is current. Or set `SKALD_TERRAIN_SEED`,
  `SKALD_TERRAIN_SEED_HASH` and `SKALD_TERRAIN_WORLDGEN_VERSION` yourself.
  `SKALD_TERRAIN_RES` (2048, up to 4096), `SKALD_TERRAIN_THREADS` (4),
  `SKALD_TERRAIN_FORCE=true` (run even when current).
- Output in `TERRAIN_DIR`: `biomes.u8`, `height.u16le` and `manifest.json`
  (format, seed hash, generator version, game build, resolution, radius),
  manifest last. A run whose seed, generator, game build and resolution match
  the files already there writes nothing.
- The agent checks the grids against the save and paints them once per cache
  key with its own palette and a hillshade (2048 px: about 0.5 s, a 0.8 MB
  PNG). Grids for another seed or generator are never served; grids from an
  older game build are shown and marked stale. `/state.terrain` has
  `available`, `stale`, `reason` (`missing`, `seed`, `worldGenVersion`,
  `gameBuild`, ...), `build` and the `request`; `GET /terrain.png` (ETag =
  cache key, immutable) and `GET /terrain.json` serve it, and the web tier
  proxies them as `/api/terrain.*`.
- Exit codes of a run: 0 written, current or nothing to do; 10 bad settings;
  11 the game's API is not what the plugin expects (a game update changed
  it: the last good terrain stays); 12 sampling failed or timed out; 13 the
  output is not writable; 20 the agent is unreachable; 21 the agent cannot
  read the world.
- The terrain shows the whole seed's land to signed-in viewers who open
  `/api/terrain.png` directly, as the seed shown on the dashboard already
  does. The map itself only draws it where the world has been generated.

**Kubernetes**: enable the `terrain` component in
[`kustomization.yaml`](../deploy/kubernetes/kustomization.yaml). It adds, in
the game's namespace, the PVCs `skald-terrain` (output, mounted read-only by
the agent at `/terrain`) and `skald-terrain-game` (the run's own server
install, 10 GiB, re-downloadable: a node-local class is fine), a daily
CronJob `skald-terrain` and a NetworkPolicy for it (egress to DNS, the agent
and Steam/Thunderstore only), plus an ingress rule on the game pod's policy
so the run can ask the agent. The run needs the output volume on the game
pod's node (ReadWriteOnce), so it has required podAffinity to the game pod
and stays Pending while that pod is down. Next to the game it runs with 2
threads, a CPU limit of 2 and lowered priority. Run it right away with:

```sh
kubectl -n valheim create job --from=cronjob/skald-terrain skald-terrain-now
```

The first run downloads the server (about 2 GB, a minute or two); later ones
take about 35 s, or seconds when nothing is due. Mounting the output into the
agent changes the game pod, so enabling the component restarts the server once.

**Compose**: `docker compose --profile terrain run --rm terrain`. The agent
mounts the `skald-terrain` volume read-only with `TERRAIN_DIR=/terrain`.

## Admin bridge

Opt-in. Live admin commands from the panel: broadcasts, items and kits,
teleport, heal and Rested, time of day, raids, creatures, world keys, base
helpers (repair, fill kilns and smelters, grow crops, reveal the map and pin
on cartography tables), save, kick and ban; plus every player on the map,
moving, every 2 seconds.

It needs a **server-side BepInEx plugin**, the Skald bridge
([`bridge/`](../bridge/README.md)). It runs inside the game process, listens
on `127.0.0.1:9010` only, and calls the operator's own installed game code. It
ships as `ghcr.io/krystianslowik/skald-bridge` (busybox, the DLL and an
install script, used as an initContainer); it contains no game code.

```
browser --cookie--> skald-web --X-Agent-Token--> agent --X-Skald-Token--> plugin 127.0.0.1:9010
```

**Enable it**

| Where | Setting |
|---|---|
| Game container | `BEPINEX=true`, `SKALD_BRIDGE=on` (kill switch: `off`), `SKALD_BRIDGE_TOKEN` (16+ characters, from a Secret) |
| Plugin | the `skald-bridge` initContainer (Kubernetes) or the `bridge-plugin` service (Compose), before the game starts |
| Agent | `BRIDGE_TOKEN`, the same value; `BRIDGE_URL` stays at its default |
| Web | nothing; `ADMIN_PASSWORD_HASH` is recommended (see [Roles](#roles)) |

Kubernetes: the `bridge` component in
[`kustomization.yaml`](../deploy/kubernetes/kustomization.yaml), plus
`BRIDGE_TOKEN` in the `skald-agent` Secret. Compose: `COMPOSE_PROFILES=bridge`
(comma-separated with others), `BEPINEX=true` and `BRIDGE_TOKEN` in `.env`.
Either restarts the game once and changes the join code: do it with nobody
online. `BEPINEX=true` makes the image download BepInEx (about 1 MB from
Thunderstore, TCP 443, already allowed) and adds about 30 s to the first
start. The NetworkPolicy needs no change: the plugin is loopback only.

**The agent's side**

- `GET /bridge/status`: `available`, `reason` (`unreachable`: not installed,
  BepInEx off, kill switch, or still starting; `disabled`: the plugin turned
  itself off, usually after a game patch; `token`; `loading`; `restarting`),
  the plugin version and the **game build**, `tested` and `acknowledged`.
- `GET /bridge/players`: name, platform type, position and health. The
  plugin's peer uids, platform ids and PlayFab ids **never leave the agent**:
  it keeps a private name to uid table and swaps a name for its uid before a
  command goes on.
- `GET /bridge/{time,events,globalkeys,locations,bans}`. The ban list comes
  back as opaque ids (and a name when the agent saw the player connected);
  `unban` takes such an id.
- `POST /bridge/{command}` for one allow-list: `broadcast, save, kick, ban,
  unban, time, skip-to-morning, time-freeze, time-resume, event-start,
  event-stop, spawn, teleport, globalkey-set, globalkey-remove,
  creature-spawn, creature-kill, creature-tame, heal, status, repair, fill,
  grow, map-reveal, map-pins`, plus `ack-build`. Bodies are JSON objects
  (`{}` at least, 16 KB max), `X-Skald-Actor` is passed through to the
  plugin's audit line, 8 s timeout. The plugin's 400/404/409/501/503/504
  pass through; an unreachable plugin is 502. Commands are refused while a
  restart runs, but do not wait for backups or updates.
- **Game build gate.** On a build not in `BRIDGE_TESTED_BUILDS`, commands
  answer 409 until an admin confirms the build in the panel (held button, kept
  in `SETTINGS_DIR/bridge.json`). Reads keep working.
- **Saga.** The plugin writes an audit line before and after every command.
  The agent turns each pair into an `admin` event: who, which command, the
  result, the player **by name**, and an allow-listed summary of the
  arguments (item, amount, quality, creature, key, time, the broadcast text,
  ...). Platform ids and uids are dropped, error messages redacted. The web
  tier keeps them in the history, so the Saga reads "Sigrun spawned 20 Wood
  for Ragnar". The full lines stay in the game log (with ids redacted in the
  Chronicle).
- **Live positions.** While at least one SSE client is subscribed (skald-web
  always is) and somebody is playing, the agent polls the plugin every 2 s and
  publishes a `positions` event (name, platform, x, z, health) when something
  moved. It is volatile: no sequence number, not replayed, not stored, and not
  on the metrics port. skald-web passes it to browsers at most every 2 s.

**Who is named.** The actor in the saga is the name a device set in the admin
sheet ("Your name in the saga", kept in that browser) folded to ASCII, or
`dashboard-` plus a short hash of the session.

### Roles

Without `ADMIN_PASSWORD_HASH`, anyone who knows the panel password can
spawn items, kill, ban and teleport. Keep the password strong and the panel
behind your access layer, or set an admin password:

- The panel password then only views (the map, live players and the saga
  included).
- Admin commands, restarts, backups, updates and saving or applying server
  settings answer 403 until the browser unlocks an admin session with the
  admin password (`POST /api/admin/unlock`, rate-limited like the login: 5
  tries a minute, then 15 minutes).
- The admin session is a second signed cookie, tied to the panel session,
  that lasts 30 minutes from the last admin action. "Lock" ends it at once;
  logging out ends both.
