---
name: cockpit-planning
description: Kick off the planning stage of the cockpit pipeline — explores the repo, decides whether the work splits into milestones, names a real verifier, writes runnable e2e tests, and dispatches a fresh Opus 5 session to do that work. Invoke from the orchestrator's own session as `/cockpit-planning <free-text instructions or a backlog item>`. Do NOT open a new tab for yourself — this runs in the orchestrator, the same way run-orchestrator does.
---

# Cockpit Planning

Everything about *what planning does* — test conventions, verifier expectations, what counts as "explored enough" — is fully owned here and can be edited without touching the orchestrator or any other pipeline-stage skill. Only the mechanical *how a tab gets opened* is shared: see `orchestrator-prompt.md` step 4's "Reusable form" for that (one procedure, every pipeline dispatch supplies its own parameters). This is the one stage that stands up a brand-new worktree and branch — there is no prior task dir yet.

## Step 1 — Resolve what's being planned

- If given a backlog item: find its line in `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/BACKLOG.md`, use its description as the task, and remove it from there entirely once dispatch succeeds — the dispatched task dir is the record from then on, not a struck-through backlog line. If the line carries a `[<project>]` tag, that is the task's Repo — don't re-ask — and the tag is stripped from the description used as the task title.
- **Weekly-focus check (before doing anything else in this step):** Read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/WEEKLY_FOCUS` — the free-text "This Week" focus banner the developer sets via the dashboard UI. If the file is empty or missing, skip this check. If it has content and the task doesn't obviously fit that focus, **stop and ask the developer to confirm**, with exactly two options: run it anyway, or backlog it instead (add/restore the line in `BACKLOG.md` rather than dispatching, written in `orchestrator-prompt.md`'s Backlog Entry format; when restoring a line this skill removed, restore its `[<project>]` tag with it). Don't silently proceed and don't silently backlog it either — the developer decides. This mirrors `orchestrator-prompt.md`'s step 3 gate for the ad-hoc dispatch path — it has to be repeated here because `cockpit-planning` is a separate entry point with its own Step 1 that doesn't inherit that file's steps.
- If given free text: that's the task description directly.
- Derive a slug (short, kebab-case, derived from the task description) and the repo. **If the repo isn't explicitly clear, ask before proceeding.**
- Check whether `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>` already exists. If it does and `STATUS` reads `done`: append a `## ⚠️ NEW REQUEST (<date>)` section to its `TASK.md` (restating `Repo:`/`Branch:`/`Mode:` even if unchanged — the dashboard reads the *last* occurrence of each), retire the old session with `tmux kill-session -t =worker-<slug> 2>/dev/null; exit 0` while `STATUS` still reads `done`, then reset `STATUS` to `working` and continue below as a fresh dispatch. If it exists with any other `STATUS`, that's a live or unfinished task — stop and ask rather than colliding with it.

## Step 2 — Write `TASK.md`

Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TASK.md`:

```
# <Task title>

## Workspace
- Repo: <repo>
- Branch: claude/<slug>
- Branch status: new

## Mode: implement
Explore first. Decide flat-vs-milestone. Name a real verifier. Write real e2e tests, not descriptions of them. Keep the plan to what the task actually needs — generation is cheap, so the real risk is over-scoping (extra milestones, unneeded abstractions), not under-building.

## Context
<whatever background — Jira/Slack links, prior findings — the developer gave.>

## Steps
1. Enter Plan mode and actually explore the repo before proposing anything — no guessing at structure from the task description alone.
2. Decide whether this work splits into milestones (independent-ish chunks with real dependencies between them) or is a single flat unit. Don't force a split onto something that doesn't need one.
3. If splitting into milestones, write a `## Milestones` section into `tech-design.md` in exactly this format (what `taskParser.ts`'s `parseMilestonesContent` and `docs/tech-design-template.md` expect):
   ```
   ## Milestones
   - M0: Rename + Vercel — needs: none — est: 2h — spec: e2e/rename.spec.ts
   - M1: Config foundation — needs: M0 — est: 4h — spec: e2e/config.spec.ts
   ```
   One bullet per milestone. Ids must be `M<digits>` — that's what later maps to a dispatched `<this-slug>-m<N>` child task. `needs:`/`est:`/`spec:` are optional and order-independent; omit `needs:` (or write `needs: none`) for a root milestone. `spec:` names the relative e2e file path(s) (comma-separated if a milestone's cases span more than one file) holding that milestone's own cases — declaring it lets the dashboard preview that milestone's planned QA case titles before `cockpit-qa` ever runs (see `qaSpecFile` in `types.ts`). Each milestone should get its own dedicated spec file(s), not a shared one — this is also what keeps `@pending`-tagging (see below) scoped correctly.
4. Name a **real, confirmed** verifier — a command that actually exists and runs in this repo, not an invented one. This becomes `VERIFY`'s first line.
5. Write **real, runnable e2e tests** (the repo's existing e2e framework, e.g. Playwright) covering the plan's QA cases — not prose descriptions. `cockpit-qa` executes these directly later.
6. Write `tech-design.md` (with the `## Milestones` section if applicable), commit the e2e test files alongside it, write `VERIFY`, and append a `TIMELINE` line for stage `planning`. Require a `## Summary` section directly under the title — 2–4 sentences on what the plan does and why (see `docs/tech-design-template.md`); the dashboard's Plan tab pins its prose above the document and strips it from the rendered body below, so this section must be prose only — no `**QA Spec:**` line, table, or anything else you'd need to see rendered further down. **For a flat (non-milestone) task**, also add a standalone line anywhere in `tech-design.md` **outside** the `## Summary` section (e.g. under the title, or in a QA section) naming its own spec file(s), in exactly this format (what `parseQaSpecFile` expects): `` **QA Spec:** `e2e/<name>.spec.ts` `` — comma/`and`-separate multiple backtick-quoted paths if the task's cases span more than one file. Do **not** hand-write the per-milestone/flat test title list anywhere in the doc — the dashboard derives it live from `spec:`/`**QA Spec:**` plus the spec files' own `test()` titles, so a hand-written copy would go stale the first time dev renames or adds a case.

## Engineering Constraints (required)
Before writing `TASK.md`, read `${REPOS_DIR:-$HOME/Dev}/pipelinely/docs/engineering-constraints.md` and copy its bullet list verbatim into this section — that file is the single source of truth for what every dispatch expects; don't hardcode the bullets here or let this copy drift from it.

## Output
`tech-design.md`, the e2e test files, `VERIFY`.

## Session continuity (required)
When this session grows long, proactively suggest `/handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. When you need input: `echo "waiting: <reason>" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS`. When the plan is ready: `echo "waiting: plan ready for review" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS` — **not** `done`. `done` is reserved for after the whole pipeline (through merge) completes.

## Pipeline artifact reporting (required)
- **TIMELINE** — append one line per stage transition: `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) planning <note>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`
- **VERIFY** — write once: `echo "<verify command>" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/VERIFY`
- **tech-design.md** — copy your plan doc's full contents, verbatim, to `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/tech-design.md`.

## Metrics reporting (required)
Periodically (after `STATUS` changes, before `/handover`, or every ~15-20 tool calls) run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
```

## Step 3 — Open the tab

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>` · `<launch-script>`: `launch.sh`
- Claim `ITERM_SESSION`/`TMUX_SESSION`: yes — there's no prior tab for this task to protect
- Worktree: **new** — branch is new, standard `git checkout -b claude/<slug>` flow
- `COCKPIT_STAGE`: `planning`
- **`launch.sh`'s `claude` line must be `exec claude --model opus "<prompt>"`, not bare `exec claude`.** This stage requires Opus 5 (see this skill's own description) — the shared form defaults to no model flag, so it does not get added unless stated here explicitly. Omitting it doesn't error, it just silently dispatches on the default model instead — confirm the flag is actually in `launch.sh` before opening the tab, don't just remember to add it.

## Step 4 — Track

`TaskCreate`, mark in_progress, store scratch dir path + branch + repo + any external link in metadata, add to the status board.

## What happens next

Once the fresh session finishes and `STATUS` reads `waiting: plan ready for review`, the developer triggers `/cockpit-plan-review <slug>` themselves — this skill does not chain into it automatically.
