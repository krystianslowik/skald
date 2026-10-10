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
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## skald-web

| Variable | Default | Description |
|---|---|---|
| `AGENT_URL` | (required) | e.g. `http://valheim:8080` (Compose) or `http://skald-agent.valheim.svc.cluster.local:8080` |
| `AGENT_TOKEN` | (required) | Same value as the agent's |
| `PANEL_PASSWORD_HASH` | (required) | argon2id hash; generate with `skald-web hash-password` |
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

The Terrain tab embeds [valheim-map.world](https://valheim-map.world/), a
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
