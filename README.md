# Pipelinely

A local dashboard + workflow orchestrator for running a fleet of Claude Code
worker agents through a real staged pipeline — Planning → Plan Review → Dev →
QA → QA fixes → Code Review → Comment fixes → Merge — each stage its own
isolated worker in its own git worktree and its own tmux session/iTerm2 tab.
The dashboard shows every task's live stage, context %, token cost, and a
one-click jump back to its terminal; the orchestrator never does task work
itself, it only dispatches.

> macOS + iTerm2 only — tab dispatch and the → Terminal focus use AppleScript
> against iTerm2. Sessions run in tmux underneath, so they survive a closed
> tab or a sleeping machine and can be reattached from anywhere (e.g. over
> Tailscale + `tmux attach`), even though the dashboard's own UI listens on localhost only by
> default (see [Network access](#network-access)).

## Prerequisites

- macOS + iTerm2
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`, or the
  [tmux installer](#dotfiles) below
- Node 20+
- [`gh`](https://cli.github.com/), authenticated (`gh auth login`)
- `jq`
- [Claude Code](https://claude.com/claude-code), with the **superpowers**
  plugin installed — the dev and qa-fixes skills invoke `superpowers:*`
  skills for TDD, worktrees, and code review
- the [plannotator](https://github.com/anthropics) CLI, if you want inline
  visual feedback on plans and PRs (see [Dotfiles](#dotfiles))

## What's in here

- **`src/`, `web/`, `public/`** — the dashboard: an Express + SSE server
  (`src/server.ts`) serving a Vite + React client built from `web/` (run
  `npm start`, which builds it first) into `public/dist/`. `public/art/`
  holds the design's own images. Watches the tasks directory and pushes
  live updates over `/events`.
- **`orchestrator-prompt.md`** — the orchestrator's behavior spec: dispatch
  rules, the weekly-focus gate, the `TASK.md` skeleton, milestone fan-out.
  The source of truth `pipelinely` loads.
- **`docs/engineering-constraints.md`** — the one file that defines what
  every dispatched task is required to do (test coverage, error logging,
  `data-testid` selectors, no duplication, follow existing conventions).
  Every `pipelinely-*` skill copies this verbatim into the `TASK.md` it writes —
  edit it once here to change what every future dispatch expects.
- **`docs/tech-design-template.md`** — the shape a `tech-design.md` should
  take; planning writes to this template, plan review holds it to it.
- **`.claude/skills/`** — the pipeline, one skill per stage plus three
  cross-cutting ones:
  - `pipelinely` — turns the current tab into the orchestrator.
  - `pipelinely-planning` — explores the repo, decides milestones vs. flat,
    writes `tech-design.md` + e2e tests, in a fresh Opus 5 session.
  - `pipelinely-plan-review` — a *different*, fresh Opus 5 session that has
    never seen the plan reviews it cold and revises it in place.
  - `pipelinely-dev` — TDD implementation through to an opened PR, in its own
    long-lived tab (refuses to start a milestone whose `needs:` dependency
    hasn't merged yet).
  - `pipelinely-qa` — a fresh session runs the e2e tests planning wrote against
    the live PR and writes `QA_REPORT.md`. Never the dev's own tab or
    session — the code's author is the worst judge of whether it works.
  - `pipelinely-qa-fixes` — fixes the failures the developer checked off,
    re-verifies, hands back to a fresh `pipelinely-qa` re-run. Runs *in* the
    dev's own tab, deliberately, since fixing benefits from the context a
    fresh QA session doesn't have.
  - `pipelinely-cr` — a fresh session runs its own diff-based code review
    against the PR (a built-in review — `gh pr diff` plus
    `docs/engineering-constraints.md`) and persists it to
    `task-pr-review.md`. Same independence rule as QA.
  - `pipelinely-cr-fixes` — fixes the review comments checked off in
    `TRIAGE.json`, pushes, and annotates which comments were skipped.
  - `pipelinely-handover` — end-of-session transfer: writes continuation
    context and opens a fresh tab that auto-resumes the task.
  - `pipelinely-feedback` — files what you tell it as a public GitHub issue
    on this repo via `gh issue create`, but only after showing you the exact
    text and getting your explicit yes; paths, repo names and task titles are
    left out unless you ask. Try `/pipelinely-feedback <what's wrong>`.

### Want a more thorough, team-specific reviewer?

`pipelinely-cr`'s built-in review is generic on purpose. For a deeper,
team-specific self-review step, start from
[`ayaniv/t2a-review-template`](https://github.com/ayaniv/t2a-review-template)
and wire it in as your own review skill.

## Quick start

One command clones the repo (skipped if you already have it), installs
dependencies, symlinks the pipeline skills into `~/.claude/skills/` (see
below — no manual loop needed), and runs whichever optional [dotfiles
installers](#dotfiles) their required binary is already on your `PATH`:

```bash
curl -fsSL https://pipelinely.cc/install.sh | sh
```

`PIPELINELY_DIR` overrides where it clones to (defaults to
`~/Dev/pipelinely`). Safe to re-run any time.

**Updating:** re-run the same one-liner. On an existing checkout it
fast-forwards `main` to the latest commit, reinstalls dependencies with
`npm ci` (which never rewrites the tracked `package-lock.json`), repoints the
skills, and ends by printing the installed checkout, commit and version.
Restart Claude Code afterwards — it reads skills only at session start.

It never switches your branch, discards your changes, or forces a merge. If
the checkout is on another branch, has local changes, has diverged from
`origin/main`, or can't reach GitHub, the install still finishes, but its
output ends with a **`pipelinely was NOT updated.`** block: the reason,
git's own error, and the exact command to run (for example
`git -C ~/Dev/pipelinely switch main`) before re-running the one-liner. Until
you do, your skills still point at the old checkout. (The one exception is a
`package-lock.json` rewritten by an older version of the installer: that
change is the installer's own, so it restores the file and updates.)

Or do it by hand:

```bash
git clone https://github.com/ayaniv/pipelinely.git ~/Dev/pipelinely
cd ~/Dev/pipelinely
npm install
npm start          # dashboard at http://localhost:3030 (npm run dev for watch mode)
npm test           # vitest
npm run test:e2e             # playwright, local/UI subset only (e2e/, minus e2e/integration/)
npm run test:e2e:integration # the real-integration subset (e2e/integration/) — asks for explicit confirmation first
```

`npm run test:e2e` never opens a real iTerm2 window or touches the developer's
real orchestrator session — the specs that do (real `osascript`/tmux, real
`ORCHESTRATOR_SESSION`) live in `e2e/integration/` and structurally refuse to
run without a freshly-granted consent token. `npm run test:e2e:integration`
(`scripts/e2e-integration/run.sh`) is the only way to grant one: it prints a
warning naming every spec about to run, on THIS Mac, for real, and requires an
explicit `y` at an interactive prompt — the confirmation is informed consent,
not authentication, and it expires with the shell that granted it (see
`src/e2eIsolation.ts`). In a **worktree** (not the canonical `~/Dev/pipelinely`
checkout), `npm run dev`/`npm start` also now need an explicit `TASKS_DIR` —
run either `TASKS_DIR=<worktree>/e2e/fixtures/tasks npm run dev` for a scratch
preview against fixture data, or `TASKS_DIR=~/Dev/pipelinely/tasks npm run dev`
to deliberately point at real data.

The skills under `.claude/skills/` are **project skills** — Claude Code
auto-discovers them when you work in this repo. `install.sh` already
symlinks them into your global skills dir for you; doing it by hand looks
like:

```bash
for s in .claude/skills/*/; do
  n=$(basename "$s")
  ln -sfn "$PWD/$s" ~/.claude/skills/"$n"
done
```

Then run `/pipelinely` in a dedicated tab and start dispatching —
either free-text ("build X") or `/pipelinely-planning <backlog item>` to go
straight into the pipeline.

## Privacy

No Pipelinely servers receive your code, sessions or pipeline state: there is
no Pipelinely backend, account or telemetry in the app. Pipelinely
orchestrates the Claude Code sessions you already run, on your Mac. That is
not the same as nothing leaving it: Claude Code still talks to Anthropic.
Pipelinely also runs `git` and `gh` on your behalf with your own credentials,
so those talk to GitHub, and `/pipelinely-feedback`, only when you confirm, files a
public GitHub issue.

The dashboard binds to `127.0.0.1` by default, and its fonts are served by
the dashboard itself, so loading it makes no third-party request. Reaching it
from another device on your LAN or tailnet is opt-in via `PIPELINELY_HOST`
(see [Network access](#network-access)).

## Network access

The dashboard includes endpoints that stage commands into terminal sessions,
so by default it listens on `127.0.0.1` only — not reachable from other
devices on the network. Nothing to configure, and no sign-in on this Mac.

On this Mac, the dashboard refuses a request whose `Host` is not `localhost`,
`127.x.x.x` or `[::1]` (DNS rebinding), and a write whose `Origin` or
`Sec-Fetch-Site` says another site sent it. Open it as `http://localhost:3030`;
a custom hostname pointing at 127.0.0.1, or the address `0.0.0.0`, stops
working.

Anything that is **not** this Mac needs a token. Turn remote access on once:

```bash
npm run remote-token -- create    # prints the token once
npm run remote-token -- show      # print it again, to sign a new device in
npm run remote-token -- rotate    # new token; signs every device out
npm run remote-token -- disable   # remote access off (remote clients get 403)
npm run remote-token -- status
```

The token lives in `~/.config/pipelinely/remote-token` (owner-only), never in
the repo. Open the dashboard on the other device, paste the token into the
sign-in page once, and that device stays signed in for 30 days. With no token
file, every remote request is refused. Auto-submit (a stage button that sends
its command instead of staging it) is available only to a signed-in device
connecting from a real non-loopback address; through a local proxy such as
`tailscale serve`, commands are staged, not submitted.

**What this does not protect against:**

- Anything running on this Mac: local processes and users can call the API
  with no token, and can read the token file if they run as you.
- A browser extension, or code already running as the dashboard's own origin.
- Network observers on a plain-HTTP LAN bind (`0.0.0.0`, a Wi-Fi address): the
  token crosses the network in cleartext. Tailscale encrypts the tailnet path;
  use the Tailscale address, or HTTPS via `tailscale serve`.
- A stolen, signed-in phone, until you `rotate`. Sessions are not individually
  revocable.
- Online guessing is stopped by token strength (256 random bits; a token under
  32 characters is refused), not by a rate limiter.
- A signed-in device has the same power as the desktop, plus auto-submit.

To reach it from another device (say, your phone on the same Wi-Fi or over
Tailscale), opt in with `PIPELINELY_HOST`, a comma-separated list of the
addresses to listen on:

```bash
# this Mac + your Tailscale address (find it with `tailscale ip -4`)
PIPELINELY_HOST=127.0.0.1,100.x.y.z npm start

# every interface — convenient, but see below
PIPELINELY_HOST=0.0.0.0 npm start
```

- List `127.0.0.1` too if you still want `http://localhost:3030` to work on
  this Mac: a server bound only to your Tailscale address stops answering on
  `localhost`.
- A specific LAN or Tailscale address is safer than `0.0.0.0`. `0.0.0.0` (and
  `::`) listen on every network this Mac is on, including coffee-shop and
  office Wi-Fi, and anyone on those networks can open the dashboard.
- Whenever a non-loopback address is listed, the server prints a warning at
  startup saying the dashboard is network-accessible, and whether remote
  clients must sign in or will get 403 because no token exists yet.
- An entry that isn't a valid address or hostname (or isn't an address on this
  Mac) stops the server at startup with a message naming it — it never quietly
  falls back to something else.

**Upgrading:** earlier versions listened on every interface. If you reached
the dashboard from another device before, set `PIPELINELY_HOST` as above; if
you only ever used `http://localhost:3030`, nothing changes.

## Dotfiles

Two optional installers under `dotfiles/`, alongside the existing
`dotfiles/claude-statusline/`:

- `dotfiles/tmux/install.sh` — installs a tmux config tuned for Claude Code
  (a memorable prefix, mouse support, and forwarding modified keys like
  Shift+Enter through to the running app). Backs up any existing
  `~/.tmux.conf` first.
- `dotfiles/plannotator/install.sh` — installs the three plannotator skills
  (`plannotator-annotate`, `plannotator-last`, `plannotator-review`) into
  `~/.claude/skills/`. Backs up any differing existing skill outside
  `~/.claude/skills/` first, so Claude Code never discovers the backup as a
  second skill with the same name.

Both refuse to run, with an install hint, if their required binary (`tmux`,
the `plannotator` CLI) isn't on `PATH` yet.

## Learn more

How the pipeline stages work, the dashboard's own UI, the full skills
reference, every configuration env var, and the task directory layout all
live in the [user guide](https://pipelinely.cc/docs) — kept in one place so
it can't drift out of sync with this README.

## Community Toolbox

A small curated list of skills, plugins and tools that fit an agentic pipeline
lives at [pipelinely.cc/toolbox](https://pipelinely.cc/toolbox). To add one, see
[CONTRIBUTING.md](CONTRIBUTING.md#add-to-the-toolbox).

## License

MIT — see [LICENSE](LICENSE).
