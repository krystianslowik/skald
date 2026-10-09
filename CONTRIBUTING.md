# Contributing to Skald

Thanks for helping. Skald is small on purpose; changes that keep it that way
are the easiest to merge.

## Getting started

```sh
cd web && npm install && npm run build
cd ../server && bun install && bun run dev   # mock server, password "ognisko"
```

See the [Development section of the README](README.md#development) for the
layout and the test commands.

## Before you open a pull request

- `cd agent && gofmt -l . && go vet ./... && go test -race ./...`
- `cd server && bun run typecheck && bun test`
- `cd web && npm run typecheck && npm test && npm run build`

CI runs the same checks.

## Guidelines

- **Every user-visible string goes through `t()`**, with the key added to both
  `web/src/i18n/en.ts` and `web/src/i18n/pl.ts`. A test fails if the two
  dictionaries drift apart. If you do not speak Polish, add the English text to
  `pl.ts` and say so in the PR; someone will translate it.
- **No new runtime dependencies without a good reason.** The agent is standard
  library only; the server depends on Hono alone.
- **Log patterns need evidence.** A new or changed regex in
  `agent/internal/logparse/parse.go` should come with the real log line in a
  test (redact player names and IPs if you like).
- **Never commit secrets, real IP addresses or PlayFab identifiers**, including
  in test fixtures. Use `203.0.113.0/24` (documentation range) for addresses.
- Keep the agent's API backwards compatible with the previous web release where
  you can: the two are deployed separately.
- Commit messages: short, imperative, prefixed with the area
  (`agent:`, `server:`, `web:`, `deploy:`, `docs:`).

## Real log lines wanted

The parser's join, death and raid patterns are pre-1.0 guesses (see
[Limitations](README.md#limitations-and-known-unknowns)). If you run a Valheim
1.0 server, an issue with a few lines around a player joining, dying, leaving
and a raid starting is one of the most useful things you can contribute.
