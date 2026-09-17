---
name: pipelinely-dev
description: Dispatches the dev stage for one milestone (slug `<parent>-m<N>`) or a plain flat task — refuses if a declared `needs:` milestone hasn't merged yet, then creates the task dir, worktree, branch and its own long-lived tab for TDD implementation through to an opened PR. Invoke from the orchestrator's own session as `/pipelinely-dev <milestone-or-task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit Dev

What this stage validates and implements is fully owned here — the mechanical *how a tab gets opened* is the one thing shared with every other pipeline dispatch, via `orchestrator-prompt.md` step 4's "Reusable form" (see Step 3 below). This is the one pipeline stage that stands up a brand-new worktree and branch — every other stage reuses an existing one. Its tab is also the **long-lived** one: `pipelinely-qa-fixes` and `pipelinely-cr-fixes` both continue in this same tab later, so it keeps the plain `worker-<slug>` tmux name rather than a suffixed one.

## Step 1 — Resolve the slug and check dependencies

If the slug matches `<parent>-m<N>` (a milestone child):

1. Read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<parent>/tech-design.md`'s `## Milestones` section and find the bullet for `M<N>` — this gives you its name and `needs:` list (same bullet format `pipelinely-planning` writes: `- M<n>: <name> — needs: <ids or none> — est: <estimate>`).
2. For each id in `needs:`, check `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<parent>-m<that-id-number>/STATUS`. It must read `done` (merged) — not `waiting`, not missing.
3. **If any needed milestone isn't done, refuse.** Do not create a task dir, worktree, or tab. Report exactly which milestone(s) are still blocking, and stop.
4. If satisfied (or `needs:` is empty/absent), continue, carrying the milestone's name/description forward into `TASK.md`'s `## Context`.

If the slug does **not** match `<parent>-m<N>`, treat it as an ordinary flat task. Skip the dependency check. If a `tech-design.md` already exists at this slug (written by `pipelinely-planning`), reuse it as the source of the implementation plan — **this is the common case**: for a flat task, `pipelinely-dev` is invoked on the exact same slug `pipelinely-planning` already used, not a new one.

**Weekly-focus check — only when `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>` doesn't exist yet at all** (a brand-new flat task dispatched straight to dev, skipping `pipelinely-planning` entirely — a milestone child or a flat task continuing an existing dir was already gated when its parent/earlier stage was dispatched, so don't repeat this for those): read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/WEEKLY_FOCUS`. If empty or missing, skip this check. If it has content and the task doesn't obviously fit that focus, **stop and ask the developer to confirm** — run it anyway, or backlog it instead (in `orchestrator-prompt.md`'s Backlog Entry format, tagged with this task's repo, which is known at this point). Don't silently proceed and don't silently backlog it either.

Before writing anything, check whether `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>` already exists. If it does and `STATUS` reads `done`, this is a re-dispatch — append a `## ⚠️ NEW REQUEST (<date>)` section to its `TASK.md`, retire the old session (`tmux kill-session -t =worker-<slug> 2>/dev/null; exit 0`), reset `STATUS` to `working`. If it exists with any other `STATUS` (e.g. `waiting: plan ready for review` from `pipelinely-planning`, or `waiting: plan reviewed, ready for dev` from `pipelinely-plan-review`), that's expected for a flat task continuing the pipeline — proceed.

**Separately, check whether the worktree already exists**, regardless of milestone-vs-flat: `[ -d "${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>" ]`. This is what actually decides new-vs-reuse in Steps 2-3 below — a milestone child's worktree never exists yet (first dispatch for that exact slug), so it's always new; a flat task's worktree was already created by `pipelinely-planning`, so it must be reused, never re-created. Do not assume "milestone = new, flat = new" — check the filesystem, since a milestone slug re-dispatched after a `git worktree remove` (post-merge cleanup) would also need a new one, and a flat task always needs a reuse.

## Step 2 — Write `TASK.md`

Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TASK.md`:

```
# <Milestone or task title>

## Workspace
- Repo: <same repo as the parent task, for a milestone child — read it off the parent's TASK.md>
- Branch: claude/<slug>
- Branch status: new if the worktree didn't already exist (milestone child); existing if it did (flat task continuing from pipelinely-planning)

## Mode: implement
Work test-driven. Do not mark STATUS done when finished — see Status reporting below.

## Context
<For a milestone: this milestone's name/description from the tech-design.md bullet, plus a pointer to the parent's tech-design.md for the wider project shape. For a flat task: its own tech-design.md if pipelinely-planning wrote one.>

## Steps
1. Run the e2e tests planning already wrote (or the named verifier) and confirm they fail first — do not skip this, it's the proof the tests actually exercise the change.
2. Implement until green, iterating rather than writing everything at once. Follow `superpowers:test-driven-development` for the workflow itself.
3. Once the dev server is up, write `DEV_URL` (absolute path, plain text URL) — `pipelinely-qa` refuses to run without it. **Start it with `TASKS_DIR=<worktree>/e2e/fixtures/tasks npm run dev` (`tsx --watch`), never plain `tsx`/`npm start`** — a worktree's `src/server.ts` now refuses to boot without an explicit `TASKS_DIR` (see `src/tasksDir.ts`), since a silent default would otherwise bind the real orchestrator's tasks dir from a scratch preview server. This task's own dev server typically stays up across the whole dev → CR → CR-fixes → QA lifecycle, and a non-watching process silently keeps serving whatever code existed the moment it started, so a later commit's routes/behavior (e.g. a new Express route) 404 or misbehave against a `DEV_URL` that looks live and healthy. If you ever do start it without `--watch`, restart it after any further code change before relying on `DEV_URL` again.
4. Once green, open a PR.

## Engineering Constraints (required)
Before writing `TASK.md`, read `${REPOS_DIR:-$HOME/Dev}/pipelinely/docs/engineering-constraints.md` and copy its bullet list verbatim into this section — that file is the single source of truth for what every dispatch expects; don't hardcode the bullets here or let this copy drift from it.

## Output
The PR. `DEV_URL`.

## Session continuity (required)
When this session grows long, proactively suggest `/pipelinely-handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. When you need input: `echo "waiting: <reason>" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS`. When the PR is open: `echo "waiting: PR open, ready for CR" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS` — **not** `done`. `done` is reserved for after the whole pipeline (through merge) completes; marking this `done` early would hide it from `pipelinely-cr`/`pipelinely-qa`.

## Pipeline artifact reporting (required)
- **TIMELINE** — `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) dev <PR note>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
```

## Step 3 — Open the tab

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>` · `<launch-script>`: `launch.sh`
- Claim `ITERM_SESSION`/`TMUX_SESSION`: yes — this is the tab `pipelinely-qa-fixes`/`pipelinely-cr-fixes` will return to
- Worktree: depends on the Step 1 filesystem check — **new** (standard `git checkout -b claude/<slug>` flow) if `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` didn't already exist; **reuse existing** (no `git worktree add`; `cp` the fresh `TASK.md` in, then `cd`, per the shared form's reuse-worktree note) if it did
- `COCKPIT_STAGE`: `dev`

## Step 4 — Track

`TaskCreate`, mark in_progress, store scratch dir path + branch + repo in metadata (note the parent slug for a milestone child), add to the status board.
