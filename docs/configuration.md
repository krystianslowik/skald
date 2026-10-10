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
