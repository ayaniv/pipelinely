---
name: cockpit-qa
description: Dispatches an independent, fresh QA pass against a task's already-open PR — runs the e2e tests planning wrote, against the live dev server, and writes QA_REPORT.md. The code's author is the worst judge of whether it works, so this always uses a brand-new session, and it never claims the task's ITERM_SESSION/TMUX_SESSION — the dev tab stays what → Terminal points at. Invoke from the orchestrator's own session as `/cockpit-qa <milestone-or-task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit QA

What this stage tests and reports is fully owned here — the mechanical *how a tab gets opened* is the one thing shared with every other pipeline dispatch, via `orchestrator-prompt.md` step 4's "Reusable form" (see Step 3 below). Ephemeral by design: this session does one job, writes its report, and exits — it does not become the task's ongoing home the way the dev tab is, and it must not steal the dev tab's terminal pointer.

## Step 1 — Confirm there's something to test

Check `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/DEV_URL` exists (the running dev server the PR stood up) and that e2e test files exist (written during `cockpit-planning`). If either is missing, report exactly what's missing and stop.

## Step 2 — Write `TASK.md`

Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TASK.md` (overwrite — this is a fresh, ephemeral stage, not a continuation of dev's):

```
# <Task title> — QA

## Workspace
- Repo: <same as the task's existing TASK.md>
- Branch: claude/<slug>
- Branch status: existing

## Mode: verify
Fresh, adversarial QA pass against an already-open PR. Test as an outsider, not the code's author.

## Context
The e2e tests planning wrote already exist in this worktree; DEV_URL is already recorded.

## Steps
1. `cd` into the **same existing worktree** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — do not create a new worktree or branch, this is the same code under fresh eyes, not a fork of it.
2. Test as an adversarial outsider — don't read the dev session's reasoning or assume the implementation is correct because it exists.
3. Run the e2e tests against the `DEV_URL` recorded for this task.
4. Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/QA_REPORT.md` (the tasks dir, **not** the worktree — the dashboard only reads from the tasks dir) in this exact format: `<n> of <m> cases failed` / `all <m> cases passed`, then a `### Failing Cases (<n>)` section with `` - [Label] What broke — `path/to/file.ts:42` `` bullets (omit that section entirely when nothing failed), followed by a `### Passing Cases (<m-n>)` section listing every passing case in the same bullet shape — `` - [Label] What it verified — `path/to/file.ts:42` `` — always, even when everything passed, so the dashboard can show the full case list, not just failures (`QaCase` / `parseQaCases` in `src/taskParser.ts`). **The trailing `path:line` MUST be backtick-quoted, exactly as shown above** — the dashboard's parser tolerates a bare, unquoted path too, but only as a fallback of last resort; a bullet that's malformed in some other way still silently drops even with that leniency, so always write the backtick-quoted form and never rely on it.
5. If there are failures, also write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/QA_TRIAGE.json` (same tasks-dir rule) in the format the dashboard's existing checklist UI already reads (`QaFailure` / `parseQaFailures` / `applyQaTriageSelection` in `src/taskParser.ts` — one entry per failing case, selectable) so the developer can check which ones to send to `cockpit-qa-fixes`.
6. Do not attempt fixes — that's `cockpit-qa-fixes`'s job, deliberately in a different, non-fresh session.

## Output
`QA_REPORT.md`, `QA_TRIAGE.json` if anything failed.

## Session continuity (required)
When this session grows long, proactively suggest `/handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. When done: `echo "waiting: QA found <n> issues, triage and dispatch qa-fixes" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS` if anything failed, or `echo "waiting: QA passed, ready to merge" > ...` if clean — QA is the last automated stage in this pipeline (Dev → CR → CR fixes → QA → QA fixes → Merge), so a clean pass is terminal, not a hand-off to another skill. Then exit — do not continue working, do not open another tab.

## Pipeline artifact reporting (required)
- **TIMELINE** — `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) qa <n of m cases failed>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
```

## Step 3 — Open the tab, but do not claim the pointers

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>-qa` · `<launch-script>`: `launch-qa.sh` (distinct filename, so the dev tab's own `launch.sh` isn't touched)
- Claim `ITERM_SESSION`/`TMUX_SESSION`: **no** — deliberately skip that part of the procedure. Those must keep pointing at the dev tab, which is what `cockpit-qa-fixes` returns to and what the dashboard's → Terminal button reaches.
- Worktree: **reuse existing** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — no new worktree/branch
- `COCKPIT_STAGE`: `qa`

## Step 4 — Track

`TaskCreate`, mark in_progress, add to the status board — note it as an ephemeral QA sub-session of the parent task rather than a new standalone one.
