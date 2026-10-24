---
name: pipelinely-adopt
description: The last stage of a design-system (ds) task, after its PR has merged — reads the plan's "## Affected apps" section and queues one BACKLOG item per app ("adopt <component> change in <app>"), then marks the task done. A fresh, ephemeral session that never claims the task's ITERM_SESSION/TMUX_SESSION. Invoke from the orchestrator's own session as `/pipelinely-adopt <task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit Adopt

A ds change is only finished when the apps that use the component have picked it up. This stage does not do that work: it queues one follow-up per affected app, and each follow-up is an ordinary dev task created later from the backlog (where the doc's "screenshot approval again" happens). No cross-repo fan-out is built here.

## Step 1 — Confirm there is something to adopt

Check that `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/KIND` reads `ds` and that `TIMELINE` has a `merge merged PR #<n>` line. Do not gate on `STATUS`: the merge leaves `waiting: merged, ready for adopt`, but the dispatch in Step 3 overwrites it with `working` before this session starts, so by now it never reads that. Anything else (not ds, not merged yet): report which and stop. A `TIMELINE` that already has an `adopt queued` line means adopt has run; stop unless the developer asked for a re-run (Step 2's dedupe makes that safe). The merged PR's worktree is already gone, so there is no worktree to enter — this session works from the tasks directory.

## Step 2 — Write `TASK.md`

Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TASK.md` (overwrite — this is a fresh, ephemeral stage):

```
# <Task title> — adopt

## Workspace
- Repo: <same as the task's existing TASK.md>
- Branch status: merged — no worktree

## Mode: implement
Queue one follow-up per app the merged change reaches. Touch nothing but BACKLOG.md, TIMELINE and STATUS.

## Context
The component, its Figma node and its consuming apps are in `INTAKE.md`; the apps to adopt are the bullets under `## Affected apps` in `tech-design.md`, both in the tasks dir.

## Steps
1. Read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/tech-design.md` and list the bullets under its `## Affected apps` section. No section, or no bullets: skip to step 5 with zero apps.
2. For each app, skip it if `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/BACKLOG.md` already has an item `adopt <component> change in <app>`, so a re-run never duplicates.
3. Append one item per remaining app to `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/BACKLOG.md`, in `orchestrator-prompt.md`'s Backlog Entry format: `- [ ] [<app>] adopt <component> change in <app> (<YYYY-MM-DD>)`, plus an indented context line naming the merged PR and this task's slug.
4. Append the `TIMELINE` line: `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) adopt queued <N> items" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`.
5. Write `STATUS` (below). Do not create tasks, branches or worktrees for the apps.

## Session continuity (required)
When this session grows long, proactively suggest `/pipelinely-handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. Adopt is the ds pipeline's last stage, so it is the one that marks the task done: `echo "done: adopt queued <N> backlog items" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS`, or with no apps `echo "done: no apps affected" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS`. Then exit.

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
```

## Step 3 — Open the tab, but do not claim the pointers

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>-adopt` · `<launch-script>`: `launch-adopt.sh`
- Claim `ITERM_SESSION`/`TMUX_SESSION`: **no** (`--claim-pointers no`) — the merge already retired the dev tab, and this ephemeral session must not become what → Terminal points at.
- Worktree: **none** — skip `git worktree add` and the `cp` of `TASK.md`; the embedded `claude` prompt reads `<resolved-tasks-dir>/<slug>/TASK.md` by absolute path.
- `COCKPIT_STAGE`: `adopt`

## Step 4 — Track

`TaskCreate`, mark in_progress, add to the status board — note it as an ephemeral adopt sub-session of the parent task rather than a new standalone one.
