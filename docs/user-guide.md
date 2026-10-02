# The Pipelinely user guide

Pipelinely is a local dashboard and workflow orchestrator for running a fleet
of Claude Code worker agents through a real staged pipeline — Planning, Plan
Review, Dev, QA, QA fixes, Code Review, Comment fixes, Merge — each stage its
own isolated worker in its own git worktree and its own tmux session/iTerm2
tab. The dashboard shows every task's live stage, context percentage, token
cost, and a one-click jump back to its terminal. The orchestrator never does
task work itself; it only dispatches.

Pipelinely is macOS + iTerm2 only: tab dispatch and the "Terminal" focus
button use AppleScript against iTerm2. Sessions run in tmux underneath, so
they survive a closed tab or a sleeping machine and can be reattached from
anywhere, even though the dashboard's own UI listens on localhost only by
default (see "Network access" below).

## Getting started

Run `/pipelinely` in a terminal tab open in the project you want to work
on. That turns the tab into the orchestrator — from there, just tell it
what you want built, in plain English ("build X"), or go straight into the
pipeline with `/pipelinely-planning <a backlog item>`.

The first run in a fresh project onboards it first (a few configuration
questions, then your first task); every run after that goes straight to
the orchestrator.

## The pipeline stages

`/pipelinely-planning` explores the target repo in a fresh session, decides
whether the work splits into milestones, names a real verifier, writes
runnable end-to-end tests, and writes a tech design document.

`/pipelinely-plan-review` dispatches a second, independent session — one that
has never seen the plan being written — to review it cold and revise it in
place. This can run several rounds; each round's outcome is recorded.

`/pipelinely-dev` creates the task's git worktree and branch, opens its own
long-lived tab, and implements test-driven through to an opened pull
request. It refuses to start a milestone whose declared dependency hasn't
merged yet.

`/pipelinely-qa` runs in a fresh session against the live pull request: it runs
the end-to-end suite planning wrote and writes a QA report. The code's own
author is the worst judge of whether it works, so this is always a brand-new
session — never the dev tab.

`/pipelinely-qa-fixes` fixes the failures the developer checked off, re-verifies
them, and hands back to a fresh `/pipelinely-qa` re-run. Unlike QA itself, this
one runs in the dev's own tab, deliberately, since fixing benefits from
context a fresh QA session doesn't have.

`/pipelinely-cr` runs in a fresh session too: a diff-based code review against
the pull request, persisted for the developer to triage. `/pipelinely-cr-fixes`
fixes the comments checked off, pushes, and records which comments were
deliberately skipped rather than silently dropping them.

Merge has no dedicated dispatch tab: the developer clicks Merge on the
dashboard, which runs a real merge and surfaces failures (not mergeable,
checks pending, conflicts) verbatim. `/pipelinely-merge <slug>` runs the exact
same gated merge from a terminal instead, for when that's more convenient
than the dashboard.

Multi-milestone work fans out: each milestone runs its own copy of this same
pipeline, waits on any declared dependency to reach Merge, and rolls up into
one parent card with a shared progress bar.

## The dashboard

The board has three tabs — Backlog, In Progress, Done (Done splits into
per-date cards) — plus a You tab for your own contributions. Every task gets
a shareable page across those tabs, with a Terminal button that always finds
the worker's tab by its stable session id (not by name), a VS Code button, a
Browse App button once a dev server URL is recorded, an Open PR button, and
the Merge button described above. A worker's tab or tmux session going away
doesn't lose the task: the dashboard detects an orphaned session and offers
to reattach or refocus it.

Failing QA cases and code review comments are triaged from the task page —
the developer picks what's worth fixing before dispatching a fixer, or skips
a stage entirely when there's nothing worth acting on.

Three more pages live behind the sidebar's footer: Settings, for toggling
auto mode (letting mechanical handoffs like Dev to Code Review to QA
advance without a manual click — triage decisions and merges always wait
for you); Docs, this guide; and Help, for filing a public GitHub issue
about Pipelinely.

## Skills reference

`/pipelinely` — the idempotent entry point. Onboards a fresh project on
first run, then turns the current tab into the orchestrator on every run
after.

`/pipelinely-planning <backlog item>` — explores the repo, decides milestones
versus a flat task, writes the tech design and its end-to-end tests.

`/pipelinely-plan-review <task slug>` — a second, independent session reviews
the plan cold and revises it in place.

`/pipelinely-dev <task or milestone slug>` — TDD implementation through to an
opened pull request, in its own long-lived tab.

`/pipelinely-qa <task or milestone slug>` — a fresh session runs the planned
end-to-end suite against the live pull request.

`/pipelinely-qa-fixes` — fixes the QA failures checked off, in the dev's own
tab, then hands off to a fresh `/pipelinely-qa` re-run.

`/pipelinely-cr <task or milestone slug>` — a fresh session runs a diff-based
code review against the pull request.

`/pipelinely-cr-fixes` — fixes the code review comments checked off, in the
dev's own tab, then pushes.

`/pipelinely-merge <slug>` — the same gated merge the dashboard's own Merge
button runs, from a terminal instead.

`/pipelinely-handover` — end-of-session transfer: writes a continuation summary and
opens a fresh tab that resumes the task.

`/pipelinely-feedback` — files feedback about Pipelinely itself as a public GitHub
issue. It shows you the exact title and body first and posts only after you
confirm; it leaves out file paths, repo names and task titles unless you ask
for them.

## Configuration

Everything below is optional; sensible defaults are shown. Set these in your
shell profile so both the dashboard server and the skills agree.

- `TASKS_DIR` (default `~/Dev/pipelinely/tasks`) — where task state lives; the dashboard watches it, and every skill reads and writes to it.
- `REPOS_DIR` (default `~/Dev`, or whatever `npm run repos-dir -- set <dir>` saved) — the base directory code repos are cloned into.
- `WORKTREES_DIR` (default `~/Dev/worktrees`) — the base directory for each task's own git worktree.
- `PORT` (default `3030`) — the dashboard's port.
- `PIPELINELY_HOST` (default `127.0.0.1`) — comma-separated addresses the dashboard listens on. See "Network access" below.
- `COCKPIT_TASK_SLUG` — set automatically by each stage's own launch step; a hand-started tab leaves it unset.
- `COCKPIT_STAGE` — the pipeline stage the current session is running, labeling its row in the dashboard's per-session breakdown.

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
(see "Network access" below).

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

## Task directory layout

Each task is a folder under `TASKS_DIR`:

```
<TASKS_DIR>/<slug>/
  TASK.md            the task brief: Workspace, Mode, Context, Steps
  STATUS             working | waiting: <reason> | paused: <reason> | done
  METRICS            current session: context %, model, tokens
  ITERM_SESSION      stable iTerm2 session id, for the Terminal button
  TMUX_SESSION       the named tmux session backing that tab
  DEV_URL            optional; enables the Browse App button
  VERIFY             the command that decides whether the task is done
  TIMELINE           append-only stage history, one line per event
  tech-design.md     the plan; a Milestones section here turns on fan-out
  QA_REPORT.md       QA's result, case by case
  task-pr-review.md  the code review's verdict and its fix bullets

<TASKS_DIR>/BACKLOG.md   not-yet-dispatched items, promoted from the dashboard
```

`STATUS` is the source of truth for a task's state; a missing `STATUS` file
is treated as working. The current pipeline stage is computed from
`TIMELINE`, not stored directly.

## Getting help

The Help page in the dashboard's sidebar stages a `/pipelinely-feedback` message into
the orchestrator's session for you to review and send. It files a public
GitHub issue on the Pipelinely repo with your own `gh` login, visible to
everyone and read by the Pipelinely maintainer. The skill shows you the
exact text first and posts only after you confirm (an instruction to the
skill, not a system prompt), and nothing is sent to a Pipelinely server. The
page also offers a Contact support link for anything else. You can also open
an issue directly at
[github.com/ayaniv/pipelinely/issues](https://github.com/ayaniv/pipelinely/issues).
