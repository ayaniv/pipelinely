---
name: pipelinely-design-fixes
description: Applies the designer's change notes from DESIGN_FEEDBACK.md to a design-system (ds) task, re-verifies, pushes, and hands back to a fresh pipelinely-design-qa re-run — continuing in this task's own existing dev tab rather than a fresh session, since fixing benefits from exactly the context a fresh design QA reviewer deliberately doesn't have. Invoke directly inside the task's own tab as `/pipelinely-design-fixes`.
---

# Cockpit Design Fixes

Like `pipelinely-qa-fixes`, this is **not** dispatched from the orchestrator into a new tab — it is invoked directly inside the task's own long-lived dev tab (reachable via the dashboard's → Terminal button, which `pipelinely-design-qa` deliberately never repointed away from it). There is no `TASK.md`-writing or worktree/tab-creation step here; this skill's body runs in place.

## Step 0 — Mark this session as working

Before any other step, write `STATUS` so the dashboard doesn't keep showing the prior stage's stale `waiting: ...` text while this fix session is running:
`echo "working" > ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<this-task-slug>/STATUS`

## Step 1 — Read the designer's notes

Read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<this-task-slug>/DESIGN_FEEDBACK.md` — the notes the designer typed at the approval gate — and `DESIGN_QA.md`, whose table shows which stories and themes the notes refer to and what the screenshots looked like.

## Step 2 — Apply each change

Make each change the notes ask for, in the component's real source (and its stories), not as a one-off override. A note that conflicts with the Figma node or with another note: stop and ask the developer rather than guessing.

## Step 3 — Re-verify locally

Re-run the verifier and open the affected stories in Storybook, in Light and Dark, and confirm each requested change is visible. Don't rely on the next design QA pass to catch a fix that doesn't work.

## Step 4 — Commit, push, and report

1. Commit and push the fixes.
2. Append a `TIMELINE` line for stage `design-fixes`: `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) design-fixes <what changed>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<this-task-slug>/TIMELINE`
3. Set `STATUS` to `waiting: design fixes pushed, ready to re-run design QA`.

## Step 5 — Hand back to design QA

Don't grade your own fix and call it done — that reintroduces the "author is the worst judge" problem `pipelinely-design-qa`'s fresh-session design exists to avoid. Leave `STATUS` at `waiting: design fixes pushed, ready to re-run design QA` and let the developer re-trigger `/pipelinely-design-qa <slug>` for an independent re-check.
