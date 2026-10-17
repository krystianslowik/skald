# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's
private vulnerability reporting instead:
<https://github.com/krystianslowik/skald/security/advisories/new>

Include what you found, how to reproduce it, and the affected version. You
should get an answer within a week. Fixes are released as a new patch version
and credited in the changelog unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## How Skald is meant to be deployed

- **Panel password.** Stored only as an argon2id hash (`PANEL_PASSWORD_HASH`).
  Login is rate-limited: 5 tries a minute, then 15 minutes locked.
- **Admin password (optional).** With `ADMIN_PASSWORD_HASH` set, the panel
  password only views. Admin commands, restarts, backups, updates and saving
  server settings need an admin session, unlocked with the admin password under
  the same rate limit and ended after 30 minutes without an admin action.
  Without it, everyone who knows the panel password is an admin.
- **Agent.** The web tier talks to the agent with a shared token
  (`AGENT_TOKEN`). Expose the agent's API port to the web tier only.
- **Admin bridge (opt-in).** The plugin listens on `127.0.0.1` inside the game
  pod or container and answers only requests with `SKALD_BRIDGE_TOKEN`
  (16+ characters). Only the agent talks to it. Platform and PlayFab ids stay
  inside the agent.
- **Metrics port.** `:9464/metrics` has no token. Keep it private with a
  NetworkPolicy or firewall; it carries the world and server name, never player
  positions.
- **Settings volume.** The server settings directory holds the game password in
  plain text, readable by the agent and the game. Treat it like a secret.
- **Transport.** Serve the panel over HTTPS with `COOKIE_SECURE=true`, and set
  `TRUSTED_IP_HEADER` behind a proxy so the rate limits see real addresses.
- **Origin check.** Requests that change something, and the live connection,
  are accepted only from the panel's own page (or from clients that are not
  browsers). Set `PUBLIC_ORIGIN` if a proxy rewrites the `Host` header.

More detail in [docs/configuration.md](docs/configuration.md).

## Scope

In scope, for example:

- bypassing the login, the admin unlock, a rate limit or the session check;
- reaching the agent API without the token, or reading files outside the
  backups directory;
- reaching the bridge plugin without its token or from outside the pod;
- player platform or PlayFab ids leaving the agent;
- cross-site scripting or request forgery against the dashboard.

Out of scope: weaknesses of the Valheim server, BepInEx, the community server
image or PlayFab; the documented exposures above (the token-less metrics port,
the plaintext password on the settings volume, everyone being an admin without
`ADMIN_PASSWORD_HASH`); and deployments that ignore the documented setup (for
example plain HTTP with `COOKIE_SECURE=false` exposed to the internet, or a
published supervisord port).
