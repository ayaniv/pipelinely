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
anywhere, even though the dashboard's own UI is local-only.

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
for you); Docs, this guide; and Help, for sending feedback.

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

`/pipelinely-feedback` — files feedback about Pipelinely itself as an issue, with
relevant context from what you were just doing.

## Configuration

Everything below is optional; sensible defaults are shown. Set these in your
shell profile so both the dashboard server and the skills agree.

- `TASKS_DIR` (default `~/Dev/pipelinely/tasks`) — where task state lives; the dashboard watches it, and every skill reads and writes to it.
- `REPOS_DIR` (default `~/Dev`) — the base directory code repos are cloned into.
- `WORKTREES_DIR` (default `~/Dev/worktrees`) — the base directory for each task's own git worktree.
- `PORT` (default `3030`) — the dashboard's port.
- `COCKPIT_TASK_SLUG` — set automatically by each stage's own launch step; a hand-started tab leaves it unset.
- `COCKPIT_STAGE` — the pipeline stage the current session is running, labeling its row in the dashboard's per-session breakdown.

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
the orchestrator's session for you to review and send, and offers a
Contact support link for anything else. You can also open an issue
directly at
[github.com/ayaniv/pipelinely/issues](https://github.com/ayaniv/pipelinely/issues).
