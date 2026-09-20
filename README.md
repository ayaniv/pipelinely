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
> Tailscale + `tmux attach`), even though the dashboard's own UI is local-only.

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

- **`src/`, `public/`** — the dashboard: an Express + SSE server
  (`src/server.ts`) and a single self-contained `public/index.html`. Watches
  the tasks directory and pushes live updates over `/events`.
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
  - `pipelinely-feedback` — files what you tell it as a GitHub issue on this
    repo via `gh issue create`, with a short summary of what you were doing
    right before it. Try `/pipelinely-feedback <what's wrong>`.

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
`~/Dev/pipelinely`). Safe to re-run any time — it always picks up your
latest checkout. Or do it by hand:

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

## How it works

1. `/pipelinely` turns the current tab into the **orchestrator**. It
   never does task work itself — every task, however small, gets dispatched
   to its own worker. Before writing `TASK.md` it checks the free-text
   `WEEKLY_FOCUS` banner (set from the dashboard) and asks the developer to
   confirm if a new task doesn't obviously fit it.
2. **Planning** (`pipelinely-planning`) explores the target repo in a fresh
   Opus 5 session, decides whether the work splits into milestones, names a
   real verifier, writes runnable e2e tests, and writes `tech-design.md`.
3. **Plan Review** (`pipelinely-plan-review`) dispatches a *second*, independent
   Opus 5 session — one that has never seen the plan being written — to
   review it cold and revise it in place. This can run several rounds; each
   round's outcome is logged to `TIMELINE`. The developer can also open the
   plan in **Plannotator** (`/annotate-plan/:slug` → a dedicated, ephemeral
   tmux/iTerm2 tab running `/plannotator-annotate`) to leave inline visual
   feedback on `tech-design.md` before Dev is allowed to start — deliberately
   never the orchestrator's own session, since Plannotator blocks
   synchronously on the browser round-trip.
4. **Dev** (`pipelinely-dev`) creates the task's git worktree and branch, opens
   its own long-lived tab, and implements test-driven through to an opened
   PR. Every dispatched `TASK.md` carries the constraints from
   `docs/engineering-constraints.md` verbatim.
5. **QA** (`pipelinely-qa`) and **Code Review** (`pipelinely-cr`) each run in a
   fresh session against the live PR — QA runs the e2e suite and writes
   `QA_REPORT.md`; CR runs a diff-based code review and writes `task-pr-review.md`.
   Neither ever claims the task's `ITERM_SESSION`/`TMUX_SESSION`, so
   → Terminal always points back at the dev tab. Failing QA cases and
   review comments are triaged from the dashboard (`QA_TRIAGE.json` /
   `TRIAGE.json`) — the developer picks what's worth fixing.
6. **QA fixes** / **Comment fixes** run back in the dev's own tab (context
   helps here, unlike the review stages), then hand off to a fresh QA/CR
   re-run. A stage with nothing worth acting on can be skipped from the
   dashboard instead of dispatching a fixer.
7. **Merge** is the one stage with no skill, deliberately — the developer
   clicks Merge on the dashboard, which runs a real `gh pr merge` and
   surfaces failures (not mergeable, checks pending, conflicts) verbatim.
8. Multi-milestone work fans out: each milestone (`<parent>-m<N>`) runs its
   own copy of this same pipeline, waits on any `needs:` dependency to reach
   `merge`, and rolls up into one parent card with a global progress bar.
9. Every worker's tab/tmux session is named and durable — the dashboard
   detects an orphaned session (tab closed, tmux still alive) and offers to
   reattach or refocus; **→ Terminal** always finds the tab by its stable
   iTerm session id, not by name.
10. The **dashboard** watches `TASKS_DIR`, pushes live updates over SSE, and
    gives each task a shareable `/task/<slug>` page across three tabs —
    Backlog, In Progress, Done (Done split into per-date cards). From there:
    → Terminal, VS Code, Browse App (dev URL), Open PR, Merge, Skip stage,
    and the QA/CR triage checklists.

## Configuration

All optional — sensible defaults shown. Set in your shell profile so both
the server and the skills agree.

| Env var | Default | What |
|---|---|---|
| `TASKS_DIR` | `~/Dev/pipelinely/tasks` | Where task state lives (gitignored, but pipeline artifacts are allow-listed so history survives). The server watches it; every skill reads/writes to it. |
| `REPOS_DIR` | `~/Dev` | Base dir where code repos are cloned (`$REPOS_DIR/<repo>`). |
| `WORKTREES_DIR` | `~/Dev/worktrees` | Base dir for per-task git worktrees (`$WORKTREES_DIR/<slug>`). |
| `PORT` | `3030` | Dashboard port. |
| `COCKPIT_TASK_SLUG` | _(set per worker tab)_ | Set by each stage's `launch.sh` when it opens a tab; the statusline hook and `write-metrics.sh` use it to write that session's `METRICS-<session-id>.json`. |
| `COCKPIT_STAGE` | _(set per worker tab)_ | The pipeline stage this session is running (`planning`, `qa`, …). Labels the session's row in the dashboard's per-session breakdown; `null` for a hand-started tab. |

## Task directory layout

Each task is a folder under `TASKS_DIR`:

```
<TASKS_DIR>/<slug>/
  TASK.md           # the task brief (Workspace, Mode, Context, Steps, …)
  STATUS            # "working" | "waiting: <reason>" | "paused: <reason>" |
                     # "review" | "review: <PR url or number>" | "done" |
                     # "handover: session #N — …"
  METRICS           # { contextPct, model, inputTokens, outputTokens } — current session
  METRICS-N.json    # historical snapshots (handover cost tracking)
  METRICS-<session-id>.json  # one per Claude session: stage, context, tokens, startedAt/updatedAt
  ITERM_SESSION     # stable iTerm2 session id for → Terminal focus
  TMUX_SESSION      # named tmux session backing that tab — survives the tab closing
  HANDOVER-N.md     # continuation context written by /pipelinely-handover
  DEV_URL           # optional — enables the Browse App button
  VERIFY            # the command or target that decides whether this task is done
  TIMELINE          # append-only "<ISO> <stage> [note]" lines — the task's stage history
  tech-design.md    # the plan; a "## Milestones" section here turns on the milestone fan-out view
  QA_REPORT.md      # QA's result — the "<n> of <m> cases failed" headline plus Failing Cases and Passing Cases lists (the full case list, not just failures)
  task-pr-review.md # the code review's verdict and its Must Fix / Should Fix bullets
  TRIAGE.json       # which review findings the human selected for a fixer agent
  QA_TRIAGE.json    # which failing QA cases the human selected — a separate sidecar, since a task can carry both
  launch.sh          # the shell command each stage's tab was opened running (exports COCKPIT_TASK_SLUG/COCKPIT_STAGE)
  launch-annotate.sh # written by /annotate-plan — opens Plannotator against this task's tech-design.md

<TASKS_DIR>/WEEKLY_FOCUS  # plain-text banner shown at the top of the dashboard, edited in-place from the UI
<TASKS_DIR>/BACKLOG.md    # "- [ ] [<project>] <description> (<date>)" lines — [<project>] optional; not tasks yet, promoted via the dashboard's backlog panel
```

`model` may be a string or `{ id, display_name }`. `STATUS` is the source of
truth for state; a missing `STATUS` is treated as `working`. The current
pipeline **stage** (`planning` / `plan-review` / `dev` / `qa` / `qa-fixes` /
`code-review` / `comment-fix` / `merge`) is computed from `TIMELINE`, not
stored — see `computeStage` in `src/taskParser.ts`.

### Community Toolbox

A small curated list of skills, plugins and tools that fit an agentic pipeline
lives at [pipelinely.cc/toolbox](https://pipelinely.cc/toolbox). To add one, see
[CONTRIBUTING.md](CONTRIBUTING.md#add-to-the-toolbox).
