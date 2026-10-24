---
name: pipelinely-design-qa
description: Dispatches an independent, fresh design QA pass against a design-system (ds) task's already-open PR — runs the repo's Storybook, screenshots every story of the changed component in Light and Dark, gets the matching Figma screenshots through the Figma MCP, and writes DESIGN_QA.md for the designer's approval gate. Same independence rule as pipelinely-qa — a brand-new session that never claims the task's ITERM_SESSION/TMUX_SESSION. Invoke from the orchestrator's own session as `/pipelinely-design-qa <milestone-or-task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit Design QA

Only a `KIND`=`ds` task runs this stage: `pipelinely-qa` hands off to it instead of merge, and the designer's approval comes after it. What it compares and reports is fully owned here — the mechanical *how a tab gets opened* is shared with every other pipeline dispatch, via `orchestrator-prompt.md` step 4's "Reusable form" (see Step 3 below). Ephemeral by design: this session does one job, writes its report, and exits, so it must not steal the dev tab's terminal pointer.

## Step 1 — Confirm there's something to compare

Check that `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/KIND` reads `ds`, that the task has an open PR, and that the plan names the changed component (and its Figma node) — `INTAKE.md` and `tech-design.md` in the task dir say which. Anything missing: report exactly what is missing and stop. Design QA never writes a passing report on a guess.

## Step 2 — Write `TASK.md`

Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TASK.md` (overwrite — this is a fresh, ephemeral stage, not a continuation of dev's):

```
# <Task title> — design QA

## Workspace
- Repo: <same as the task's existing TASK.md>
- Branch: claude/<slug>
- Branch status: existing

## Mode: verify
Fresh, adversarial visual comparison of an already-open PR against its Figma design. Judge as an outsider, not the code's author.

## Context
The component, its variants and the Figma node are recorded in `INTAKE.md` and the plan in the tasks dir. The designer reads your report next and decides whether the change ships.

## Steps
1. `cd` into the **same existing worktree** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — do not create a new worktree or branch.
2. Run the repo's Storybook (its `storybook` script) and open every story of the changed component. If Storybook cannot start, report what is missing and stop — never write a passing report on a guess.
3. Screenshot every story in **Light and Dark** into `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/design-qa/` (the tasks dir, **not** the worktree), as `<story>-<theme>.png` in lowercase kebab-case, e.g. `primary-light.png`.
4. For each story, get the matching Figma screenshot per variant through the Figma MCP and save it beside the Storybook one as `<story>-<theme>-figma.png`. If the Figma MCP is not authenticated, report that and stop.
5. Compare each pair. Look at spacing, radius, colour tokens, type and states, not only overall likeness, and write down each real difference with the values on both sides (e.g. `border radius 6px vs 8px`).
6. Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/DESIGN_QA.md`: a one-line headline (`<n> stories compared, <k> mismatches flagged`), then a table with the columns `Story | Theme | Storybook | Figma | Match`, where Storybook and Figma are the screenshot paths relative to the task dir (e.g. `design-qa/primary-light.png`, exactly as saved in step 3 and 4 — the dashboard finds the images by that `design-qa/<file>` form) and Match is `yes` or `no — <the difference>`.
7. Do not attempt fixes — a mismatch is the designer's call: they approve it or send it to `pipelinely-design-fixes`.

## Output
`DESIGN_QA.md` and the `design-qa/` screenshots.

## Session continuity (required)
When this session grows long, proactively suggest `/pipelinely-handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. When done: `echo "waiting: design QA done, ready for design approval" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS`. Then exit — do not continue working, do not open another tab.

## Pipeline artifact reporting (required)
- **TIMELINE** — `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) design-qa <n stories compared, k mismatches flagged>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
```

## Step 3 — Open the tab, but do not claim the pointers

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>-dqa` · `<launch-script>`: `launch-dqa.sh` (distinct filename, so the dev tab's own `launch.sh` isn't touched)
- Claim `ITERM_SESSION`/`TMUX_SESSION`: **no** — deliberately skip that part of the procedure. Those must keep pointing at the dev tab, which is what `pipelinely-design-fixes` returns to and what the dashboard's → Terminal button reaches.
- Worktree: **reuse existing** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — no new worktree/branch
- `COCKPIT_STAGE`: `design-qa`

## Step 4 — Track

`TaskCreate`, mark in_progress, add to the status board — note it as an ephemeral design-QA sub-session of the parent task rather than a new standalone one.
