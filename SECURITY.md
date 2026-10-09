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

## Scope

Skald guards one dashboard with one password. In scope, for example:

- bypassing the login, the rate limit or the session check;
- reaching the agent API without the token, or reading files outside the
  backups directory;
- cross-site scripting or request forgery against the dashboard.

Out of scope: weaknesses of the Valheim server, the community server image,
PlayFab, or deployments that ignore the documented setup (for example plain
HTTP with `COOKIE_SECURE=false` exposed to the internet, or a published
supervisord port).

See the [Security model](README.md#security-model) section of the README for
how Skald is meant to be deployed.
