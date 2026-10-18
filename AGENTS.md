# Working on Skald (for agents and humans)

How work on Skald is planned, done and shipped. It sits on top of
[CONTRIBUTING.md](CONTRIBUTING.md), which covers the setup, the checks and the
style rules; read that first. Anyone can pick up a task with this page alone,
person or AI agent, and the next one can carry on from where it stops.

## The loop

Every release has two tracks, run side by side:

1. **Build.** Fix and build from the top of the backlog plus what the owner
   asked for. Skip issues labelled `hold`.
2. **Recon.** Hunt for new bugs by running the code. Findings are filed as
   issues for the *next* release, not squeezed into the one in progress.

The issue tracker is the backlog. There is no backlog file in the repository.
The board (below) shows the open work by status, priority and release. The
pinned issue **"Backlog: improvement loop"** keeps the coverage of every recon
round.

## Issues

One issue per problem. Use the templates. Labels:

| Label | Meaning |
|---|---|
| `bug`, `enhancement`, `documentation`, `accessibility` | kind |
| `prio:high`, `prio:medium`, `prio:low` | high: users notice it now or data is at risk. medium: wrong but has a workaround. low: polish |
| `area:agent`, `area:server`, `area:web`, `area:bridge`, `area:deploy`, `area:docs` | where the fix lands; add several if needed |
| `recon` | found by a recon round |
| `review` | found by a code review |
| `question` | suspected, not reproduced yet |
| `hold` | plan only: the improvement loop and agents skip it until the owner removes the label |
| `redesign` | UX redesign work (main screen, tabs, admin sheet) |
| `effort:xhigh` | very large: several days across many components |

A good issue has:

- what is wrong;
- how to reproduce it (command, steps, or the test that fails);
- expected vs actual;
- the root cause with `file:line` if known;
- a suggested fix and an effort estimate (S/M/L).

Before filing, search open and closed issues. Comment on a duplicate rather
than opening a new one.

## The board

The public project [Skald](https://github.com/users/krystianslowik/projects/1)
shows the same issues by state. Labels stay the source of truth for kind and
area; the board adds four things, and every role keeps them current:

| Field | Values | Who sets it |
|---|---|---|
| Status | Todo, In progress, In review, Done | Todo when filed. In progress when work starts on a branch. In review when the PR is open. Done happens on its own when the release closes the issue |
| Priority | High, Medium, Low | when filed, matching the `prio:*` label |
| Size | S, M, L | when filed, from the effort estimate |
| Milestone | the release, e.g. `2026.10.7` | when the issue is planned for a release (a repo milestone, not a board field) |

Commands (`gh` needs the `project` scope):

```sh
gh project item-add 1 --owner krystianslowik --url <issue url>
gh project field-list 1 --owner krystianslowik --format json   # field and option ids
gh project item-list 1 --owner krystianslowik --format json    # item ids
gh project item-edit --project-id <project id> --id <item id> \
  --field-id <field id> --single-select-option-id <option id>
gh issue edit <n> --milestone <release>
```

A new release gets its milestone when the previous one ships.

**Security problems never go into public issues.** File them as a draft
security advisory (see [SECURITY.md](SECURITY.md)). That covers auth, sessions,
CSRF, rate limits, data a role should not see, injection and path traversal.
Refer to an advisory only by its GHSA id, never by its details.

## Privacy

This repository and its issues are public. Never write any of these into code,
tests, fixtures, commits, issues or pull requests:

- player names, gamertags;
- platform or PlayFab ids;
- join codes, world names, seeds;
- IP addresses or hostnames of a real server.

Nor anything that points at a real deployment: hostnames, IPs, tokens,
secrets, cluster or network details. The project is open source and public;
what runs it is not.

Logs and screenshots from a real server must be redacted first. Use fictional
names in tests (Ragnar, Freya, Bjorn, Astrid).

## Roles

A task names one role. Stay inside it.

**Implementer.** Takes one or more issues.

- Work on a branch named after the change (`saga-fold`, `notify-discord`), in
  your own git worktree when other work runs in parallel:
  `git worktree add -b <branch> <path> main`. Never commit `node_modules`
  symlinks.
- Reproduce first. Then make the fix, plus a test that fails without it.
- Run every check from CONTRIBUTING.md for each area you touched; all must
  pass.
- Add a line under `## [Unreleased]` in `CHANGELOG.md`, written for players and
  operators, not for developers.
- Commit with `Fixes #N` in the body so the release closes the issue.
- Do not push, tag or deploy unless the task says so.
- Move the issue on the board: In progress when you start, In review when the
  PR is open.
- Clean up before you report: stop every server and browser you started (by
  process id, never by pattern), and remove your worktree once the branch is
  pushed.

**Recon.** Read-only bug hunting. Do not change code.

- Start from the tracking issue's last recon entry. Cover what it lists as not
  covered.
- Run every test suite, start the mock (`bun run dev`, password `ognisko`), and
  drive it with a browser:
  - a phone viewport (390x844 with touch) and desktop;
  - both locales;
  - broken states: agent unreachable, bridge off, server stopped, empty world,
    long names, reconnect.
- Read a live server's logs only if you are given access, and only to read.
- File only what you reproduced or proved from code. Unproven ideas get the
  `question` label.
- Finish with a comment on the tracking issue: the date, what you covered, what
  you did not, and the issues you filed.

**Reviewer.** Reads a branch or `main` for design, security, performance and
drift between docs and code. It files issues, or advisories for security, the
same way recon does, with the `review` label.

**Integrator.** Merges finished branches into a release branch
(`release-YYYY.M.N`), one at a time.

- Resolve conflicts so both sides keep working. Never drop a feature or delete
  a test to make a merge pass.
- Keep one `## [Unreleased]` section in the changelog.
- Run all checks after each merge.
- Smoke-test the built app on the mock on a phone viewport, with no console
  errors.

**Releaser.** Follows "Releases" in CONTRIBUTING.md:

- release from the release branch merged into `main`;
- then a signed tag `vYYYY.M.N` (calendar versioning, see CONTRIBUTING.md);
- then wait for the Release workflow to go green.

Fixed issues close through `Fixes #N` once the release is on `main`.

After the release, clean up: delete the merged branches, local and remote,
remove leftover worktrees, and open the next release's milestone.

## Definition of done

- The issue reproduces before the change and not after.
- A test covers it.
- All checks pass for every area touched.
- The changelog entry is in place.
- Nothing private is in the diff.
- On a phone, a UI change looks right in both locales, and the console stays
  clean.

## Hand-off report

Every task ends with a short report:

- what changed (branch and commits);
- test results;
- screenshot paths for UI work;
- the issues touched;
- anything the owner has to decide.

Changes that break an operator's setup or change what players see must be
called out. Examples: a new required setting, new permissions or volume
access, changed behaviour, a data migration, a destructive action.
