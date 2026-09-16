---
name: cockpit-cr
description: Dispatches an independent, fresh code-review pass against a task's already-open PR — reads the PR's intent and diff and reviews it directly, then persists its report to task-pr-review.md. Same independence rule as cockpit-qa — a fresh session, never claiming the task's ITERM_SESSION/TMUX_SESSION. Invoke from the orchestrator's own session as `/cockpit-cr <milestone-or-task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit CR

What this stage checks is fully owned here — the mechanical *how a tab gets opened* is the one thing shared with every other pipeline dispatch, via `orchestrator-prompt.md` step 4's "Reusable form" (see Step 3 below). Mirrors `cockpit-qa`'s shape exactly, for code review instead of functional testing: fresh, ephemeral session; author is the worst judge of their own code; never steals the dev tab's terminal pointer.

## Step 1 — Confirm there's something to review

Check that the task has an open PR (its PR link, wherever the task dir records one). If there's no PR yet, report that and stop.

## Step 2 — Write `TASK.md`

Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TASK.md` (overwrite):

```
# <Task title> — code review

## Workspace
- Repo: <same as the task's existing TASK.md>
- Branch: claude/<slug>
- Branch status: existing

## Mode: verify
Fresh, independent code-review pass against an already-open PR.

## Context
The PR is already open; this session has never seen the implementation being written.

## Steps
1. `cd` into the **same existing worktree** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — no new worktree or branch.
2. `gh pr view <PR> --json title,body,baseRefName,headRefName` for intent, and `gh pr diff <PR>` for the change.
3. Read `docs/engineering-constraints.md` from the repo under review if it exists, otherwise from this checkout. Review the diff for correctness bugs, missing or weak tests (both happy and failure paths), silent failures, security issues, and violations of those constraints and of the repo's existing conventions. Read the surrounding code wherever the diff alone isn't enough to judge.
4. Write the report **verbatim** to `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/task-pr-review.md` (the tasks dir, **not** the worktree — the dashboard only reads from the tasks dir), following the example report below exactly: `### Must Fix (N)` / `### Should Fix (N)` / `### Suggestions (N)` bullets, `**Verdict: APPROVED**` / `**Verdict: CHANGES REQUIRED**`. The dashboard's checklist parses all three severities. **Every bullet's trailing location MUST be backtick-quoted** — `` - [Category] Description — `path/to/file.ts:42` `` — the dashboard's parser tolerates a bare, unquoted path too, but only as a fallback of last resort; a bullet that's malformed in some other way still silently drops even with that leniency, so always write the backtick-quoted form and never rely on it.
5. Do not attempt fixes — that's `cockpit-cr-fixes`'s job, deliberately in a different session.

## Output
`task-pr-review.md`.

## Session continuity (required)
When this session grows long, proactively suggest `/handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. When done: `echo "waiting: CR found <n> must-fix comments, triage and dispatch cr-fixes" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS` if CHANGES REQUIRED, or `echo "waiting: CR approved, ready for QA" > ...` if APPROVED. Then exit.

## Pipeline artifact reporting (required)
- **TIMELINE** — `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) code-review <verdict note>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
```

The CR session is told to follow this example exactly — it's fed through the dashboard's own `parseFindings`, `parseVerdict` and `findFindingsParseMismatch` (all three exported from `src/taskParser.ts`) so this skill's format can't drift from the parser.

<!-- example-report:start -->
## Code Review: claude/example-branch

### Must Fix (1)
- [Correctness] Off-by-one in the pagination loop skips the last page — `src/pagination.ts:42`

### Should Fix (1)
- [Test coverage] No failure-path test for a malformed response — `src/api.ts:88`

### Suggestions (1)
- [Simplification] Two call sites duplicate the same retry logic; extract a shared helper — `src/retry.ts:12`

**Verdict: CHANGES REQUIRED**
<!-- example-report:end -->

## Step 3 — Open the tab, but do not claim the pointers

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>-cr` · `<launch-script>`: `launch-cr.sh`
- Claim `ITERM_SESSION`/`TMUX_SESSION`: **no** — deliberately skip that part of the procedure. They must keep pointing at the dev tab, which `cockpit-cr-fixes` returns to.
- Worktree: **reuse existing** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — no new worktree/branch
- `COCKPIT_STAGE`: `code-review`

## Step 4 — Track

`TaskCreate`, mark in_progress, add to the status board — note it as an ephemeral CR sub-session of the parent task.
