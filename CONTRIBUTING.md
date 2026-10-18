# Contributing to Skald

Thanks for helping. Skald is small on purpose; changes that keep it that way
are the easiest to merge.

How work is planned and shipped (the issue backlog, labels, roles and the
definition of done) is in [AGENTS.md](AGENTS.md).

## Development setup

You need Go 1.27+, Bun 1.4.3+ and Node 24+. The bridge and the terrain plugin also
need the .NET SDK (8 or later; CI uses 9), and the icon extractor needs Python
3.13.

```sh
cd web && npm install && npm run build
cd ../server && bun install && bun run dev   # mock server, password "ognisko"
```

`bun run dev` sets `MOCK_AGENT=1`: a fake agent with a month of history,
players walking around the map, and a fake bridge (`MOCK_BRIDGE=off`,
`untested` or `disabled` shows the other panel states), and a compatibility
check after a game update (`MOCK_COMPAT=warn`, `fail`, `pending` or `none`;
`ok` by default). No game files are needed. For UI work, `cd web && npm run dev` runs Vite against it.

| Directory | What it is |
|---|---|
| `agent/` | Go sidecar next to the game (standard library only) |
| `server/` | Bun + Hono web tier, serves the built `web/` |
| `web/` | React dashboard |
| `icons/` | Opt-in icon extractor (Python, UnityPy) |
| `terrain/` | Opt-in terrain job and its BepInEx plugin |
| `bridge/` | Opt-in admin bridge, a server-side BepInEx plugin |
| `deploy/` | Compose and kustomize examples, monitoring |

## Tests

Run the checks for the parts you touched. CI runs all of them on every push to
`main` and every pull request.

```sh
cd agent   && gofmt -l . && go vet ./... && go test -race ./...
cd server  && bun run typecheck && bun test
cd web     && npm run typecheck && npm test && npm run build
cd icons   && pip install --no-deps -r requirements.txt && python -m unittest discover -s tests -v
cd terrain && dotnet build plugin -c Release -o out
cd bridge  && dotnet test tests && sh build.sh
kubectl kustomize deploy/monitoring   # after editing the Grafana dashboard
```

`bridge/build.sh` fetches the game's reference assemblies anonymously on its
first run (about 2 MB, into the gitignored `bridge/refs/`); see
[bridge/README.md](bridge/README.md#build).

### Real-world tests

The agent's save parser also has tests against a real 1.0 world. They skip
unless `SKALD_REAL_WORLD` points at a world directory (the one holding
`<world>.db2`, `<world>.fwl2` and the `.chunk` files):

```sh
cd agent && SKALD_REAL_WORLD=/path/to/world go test -count=1 -v -run RealWorld ./internal/world/ ./internal/worldmap/
```

Real saves hold player names and ids, so they never go into the repository;
keep the copy outside the checkout. The map and storage expectations in
`internal/worldmap` are calibrated on the save the format was worked out on;
`internal/world` only checks that the world's keys and bosses decode.

- Exact, on any copy of that save: no failed or skipped chunks, every
  inventory decodes, no unknown items, no world containers in the snapshot,
  and the generated location total (fixed by the seed, so a different world
  fails this check).
- Ranges, because they change with play: object count, placed locations,
  portals, beds, pins, bases, chest and vehicle counts, and item totals. They
  are wide enough for older and newer copies of that save and tight enough to
  catch dropped objects or misread stack sizes.
- A 2 second build budget, which depends on the machine.

All mismatches are reported in one message; `-v` logs the actual numbers, so
a range that a newer copy outgrows can be widened from them.

## Guidelines

- **Every user-visible string goes through `t()`**, with the key added to both
  `web/src/i18n/en.ts` and `web/src/i18n/pl.ts`. The typecheck fails if the two
  dictionaries drift apart. If you do not speak Polish, add the English text to
  `pl.ts` and say so in the PR; someone will translate it.
- **No new runtime dependencies without a good reason.** The agent is standard
  library only; the server depends on Hono alone.
- **Log patterns need evidence.** A new or changed regex in
  `agent/internal/logparse/parse.go` should come with the real log line in a
  test (redact player names and IPs).
- **Never commit secrets or personal data**: real IP addresses, player names,
  gamertags, platform or PlayFab ids, world names or seeds, including in test
  fixtures. Use `203.0.113.0/24` (documentation range) for addresses.
- **No game files.** Nothing extracted from or decompiled out of Valheim goes
  into the repository or the images.
- Keep the agent's API backwards compatible with the previous web release where
  you can: the two are deployed separately.
- Commit messages: short, imperative, prefixed with the area (`agent:`,
  `server:`, `web:`, `bridge:`, `terrain:`, `icons:`, `deploy:`, `docs:`,
  `ci:`). Commits and pull requests need no special trailers or sign-off.

## Releases

Versions are calendar versions, `YYYY.M.N`: year, month without a leading
zero, and a counter from 0 within the month (`2026.10.0`, `2026.10.1`,
`2026.11.0`). They are valid semver, so tools that sort versions keep working,
and every one sorts above the old `0.x` releases.

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new dated version
   heading.
2. Pin the image tags in `deploy/kubernetes` to the new version and commit both
   as `release YYYY.M.N: pin example images, date changelog`.
3. Push a tag `vYYYY.M.N`. The Release workflow builds and pushes `skald-agent`,
   `skald-web`, `skald-icons`, `skald-terrain` and `skald-bridge` for amd64 and
   arm64 to `ghcr.io/krystianslowik/`, tagged `YYYY.M.N`, `YYYY.M` (the newest release of
   that month) and `latest`
   (no `latest` for a tag with a `-` in it). When all five are pushed, it
   publishes the GitHub release with the matching changelog section as notes.

The BepInEx plugins (`bridge/`, `terrain/`) keep their own plugin version in
their source; it changes only when the plugin itself changes and is independent
of the release number.

Dependabot opens monthly update PRs for GitHub Actions, Go, npm, Bun, pip and
the Dockerfiles.

## Real log lines wanted

Joins, leaves, deaths and raids are matched against lines from real 1.0.17
servers. What is still a guess: the platform id prefixes of PlayStation and
Switch players, so they may show up without a platform mark. If you play on a
1.0 server with console players, an issue with the lines around such a player
joining (ids redacted) is one of the most useful things you can contribute.
