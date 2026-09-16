---
name: cockpit-plan-review
description: Dispatches a fresh, independent Opus 5 session that has never seen the plan being written to review a task's tech-design.md cold — checks the dependency graph, the verifier, and per-milestone shippability — and revises tech-design.md in place. Invoke from the orchestrator's own session as `/cockpit-plan-review <task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit Plan Review

What this stage checks and revises is fully owned here — the mechanical *how a tab gets opened* is the one thing shared with every other pipeline dispatch, via `orchestrator-prompt.md` step 4's "Reusable form" (see Step 3 below). Unlike `cockpit-planning`/`cockpit-dev`, this stage does **not** create a new worktree or branch: it revises the same `tech-design.md` on the same branch planning already created, in a genuinely new tab so the reviewing session shares no context with the session that wrote the plan.

## Step 1 — Confirm there's something to review

Read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/tech-design.md`. If it doesn't exist, report that and stop.

## Step 2 — Write `TASK.md`

Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TASK.md` (overwrite — this stage always starts from the current `tech-design.md`, not from what planning originally wrote in `TASK.md`):

```
# <Task title> — plan review

## Workspace
- Repo: <same as planning's TASK.md>
- Branch: claude/<slug>
- Branch status: existing

## Mode: verify
Read tech-design.md cold. Never seen it being written. Revise in place; don't just flag issues.

## Context
Fresh Opus 5, independent review of this task's tech-design.md.

## Steps
1. Read `tech-design.md` cold. Review it critically — do not assume good faith or that the plan is correct just because it exists.
2. Check the dependency graph declared in `## Milestones`: every `needs:` id must resolve to a milestone actually declared in that same section, and the graph must be acyclic.
3. Check the verifier named in `VERIFY` is real — actually runnable in this repo — not a placeholder.
4. Check per-milestone shippability: if milestone `M<n>` is merged in isolation (with only its declared `needs:` also merged), does it actually build/ship on its own? This is the crux of the review — `computeMilestones` in `taskParser.ts` trusts this dependency graph completely, so a hidden, undeclared dependency here means `cockpit-dev` can be dispatched on a milestone whose real prerequisite code doesn't exist yet.
5. Check the `## Summary` section: it must exist, be prose only (no `**QA Spec:**` line or tables inside it — the dashboard pins and strips everything under that heading verbatim, so anything but prose there renders in the wrong place), and still match the revised plan — a review round that changes scope must update it too.
6. Fix anything wrong by revising `tech-design.md` **in place** — there is no separate plan-review-fixes stage.
7. Append a `TIMELINE` line for stage `plan-review` with a round number (count existing `plan-review` `TIMELINE` entries + 1), e.g. `round 2: tightened M4's needs:, corrected verifier command`.

## Engineering Constraints (required)
- **Test coverage:** cover all new functionality with tests for both happy and failure paths, using the repo's existing test framework.
- **Error observability:** any fallible operation must handle and log errors so failures are observable.
- **Conventions:** follow the target repo's existing patterns rather than introducing new ones.
- **Test selectors:** never select elements by text content in tests. Use a `data-testid` attribute instead.

## Output
The revised `tech-design.md`.

## Session continuity (required)
When this session grows long, proactively suggest `/handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. When done: `echo "waiting: plan reviewed, ready for dev" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS`.

## Pipeline artifact reporting (required)
- **TIMELINE** — `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) plan-review <round note>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`
- **tech-design.md** — re-copy after every revision so the dashboard's copy never goes stale.

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
```

## Step 3 — Open the tab

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>-review` · `<launch-script>`: `launch-review.sh` (distinct from `launch.sh`, so planning's original dispatch record isn't overwritten)
- Claim `ITERM_SESSION`/`TMUX_SESSION`: yes — there's no long-lived "home" tab to protect yet at this point in the pipeline (that starts at `cockpit-dev`)
- Worktree: **reuse existing** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — no new worktree/branch
- `COCKPIT_STAGE`: `plan-review`
- **`launch-review.sh`'s `claude` line must be `exec claude --model opus "<prompt>"`, not bare `exec claude`.** This stage requires Opus 5 (see this skill's own description — the entire point of the stage is a fresh, independent reviewer) — the shared form defaults to no model flag, so it does not get added unless stated here explicitly. Omitting it doesn't error, it just silently dispatches on the default model instead — confirm the flag is actually in `launch-review.sh` before opening the tab, don't just remember to add it.

## Step 4 — Track

`TaskCreate`, mark in_progress, add to the status board.
