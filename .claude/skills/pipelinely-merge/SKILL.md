---
name: pipelinely-merge
description: Merges a task's already-open PR only when it's green and conflict-free, then cleans up (local branch, worktree, remote branch) and marks the task done — the same gated mergeTask() the dashboard's own Merge button uses. Invoke from the orchestrator's own session as /pipelinely-merge <slug>. Do NOT open a new tab for yourself.
---

# Cockpit Merge

**Human-gate preamble — read this before doing anything else:**
- Run this **only** because the developer typed `/pipelinely-merge <slug>`, or explicitly said to merge that specific task, in the **current turn**.
- **Never self-invoke.** A general "keep pushing things forward" instruction, an auto-mode setting, or every check passing is not authorization.
- **Never retry a refusal.** A blocked or failed run ends the turn — report it and stop.
- **Never wait or poll for checks to turn green.** This is a one-shot check, not a watcher.

This is the one `cockpit-*` skill that doesn't open a worker tab (see Step 2) — there's no code to write, no judgment a fresh session would add, and a new tab would only give the human-gate context above a place to get lost.

## Step 1 — Resolve the slug

The slug argument is required. If it's missing, **ask** — never infer "the current task"; the orchestrator has no notion of one.

## Step 2 — Run the CLI, inline, in this session

```
npm --prefix ${REPOS_DIR:-$HOME/Dev}/pipelinely run --silent pipelinely-merge -- <slug>
```

This runs `src/pipelinelyMergeCli.ts` against the real tasks dir — the same `mergeTask()` (`src/taskCompletion.ts`) the dashboard's Merge button calls. No new tab, no TASK.md, no worktree.

## Step 3 — Relay the result by exit code

- **Exit 2 (blocked):** print the blockers verbatim and stop. `STATUS` is untouched — it still reads `waiting: QA passed, ready to merge`.
- **Exit 0 (merged):** report `PR #N merged, task marked done`, plus any `cleanup:` line **as a warning**, not a success. Never "fix" a cleanup refusal with `git branch -D`/`--force`, and never delete a remote branch by hand — both need the developer's own explicit say-so, under the same post-merge cleanup convention as every other worktree teardown.
- **Exit 1 (something broke):** relay stderr and stop. If the output starts with `PR #N WAS merged`, say so **first** — the merge already happened and is irreversible — and point at the dashboard's Mark done as the recovery (a re-run of `/pipelinely-merge` is refused as `not-open`, by design).

## Step 4 — Track

Update the status board row directly — this skill doesn't write `STATUS`/`TIMELINE` itself (the CLI does), and doesn't `TaskCreate` (there's no tab to track).

**Also retire the dead tab, on exit 0 only:** the task's `worker-<slug>` tmux session has nothing left to do once its PR is merged and the worktree is gone.

```
tmux kill-session -t =worker-<slug> 2>/dev/null; exit 0
```
