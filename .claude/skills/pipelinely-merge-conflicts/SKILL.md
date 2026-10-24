---
name: pipelinely-merge-conflicts
description: Dispatches a fresh session that merges the base branch into a task's open PR when that PR conflicts with it — resolves each conflict keeping both sides' intent, re-verifies, pushes, and hands the task back to the STATUS it had before. Same independence rule as pipelinely-cr — a fresh, ephemeral session, never claiming the task's ITERM_SESSION/TMUX_SESSION. Invoke from the orchestrator's own session as `/pipelinely-merge-conflicts <milestone-or-task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit merge conflicts

The dashboard offers **Fix conflicts** in place of Start QA, Start CR and Merge whenever a task's open PR conflicts with master, and that button stages this skill. Mirrors `pipelinely-cr`'s shape: the brief is rendered from files by code, the work runs in a fresh, ephemeral tab, and the dev tab's terminal pointer is never stolen. It is never auto-dispatched — a conflict fix rewrites code on the branch, so the developer clicks it.

## Step 1 — Confirm there is a conflict to fix

Check that the task has an open PR (its PR link, wherever the task dir records one) and that GitHub reports it conflicting: `gh pr view <PR> --json mergeable,mergeStateStatus` shows `CONFLICTING` or `DIRTY`. If there is no open PR, or it is already `MERGEABLE`, report that and stop. `UNKNOWN` means GitHub is still computing it: say so and stop rather than guess.

## Step 2 — Render `TASK-merge.md`

Run `npm --prefix $HOME/Dev/pipelinely run --silent stage-brief -- merge-conflicts <slug>`. It writes `<tasks-dir>/<slug>/TASK-merge.md` from the template below and prints that path. If it exits non-zero, report its one stderr line and stop — don't hand-write the brief.

Never write or overwrite `TASK.md` here: it is the dev tab's own brief. The renderer takes only files as input — the task's `INTENT.md`, plan, `VERIFY` and `STATUS`, the PR number from the task's `TIMELINE`, and the base branch the worktree's refs name (`origin/HEAD`'s branch, else `origin/master`, else `origin/main` — the same resolution the dashboard's diff uses, so a `main`-based repo merges `origin/main`), and the conflicting file list it computes read-only with `git merge-tree --write-tree --name-only HEAD <base>` in the worktree (no fetch, no checkout, no write) — so the same files always render the same brief.

The template the renderer fills. `{{…}}` placeholders are a closed set it owns; everything else is verbatim.

```
<!-- brief-template:start -->
# {{title}} — merge conflicts

## Workspace
- Repo: {{repo}}
- PR: #{{prNumber}}
- Worktree: {{worktree}}
- Branch status: existing

## Mode: implement
PR #{{prNumber}} conflicts with its base, {{baseRef}}. Merge {{baseRef}} into this task's existing branch and resolve every conflict, keeping both sides' intent. Change nothing else: no refactor, no new feature, no unrelated fix.

## Intent (read these first)
{{intentBlock}}
- Approved plan: {{planLine}}
- Verifier: {{verifyLine}}

## Conflicting files
Base: {{baseRef}}. As of the worktree's last fetch of it (recompute after Step 1's fetch; the list may have grown):
{{conflictingFiles}}

## Steps
1. `cd` into the existing worktree at {{worktree}} — no new worktree or branch. Check `git status` is clean first; if it is not, stop and say so. Run `echo "working" > {{taskDir}}/STATUS`, then `git fetch origin`.
2. Run `git merge {{baseRef}}` — a merge commit, never a rebase, so the PR's history stays and nothing needs a force-push. Never force-push.
3. Resolve each conflicting file keeping BOTH sides' intent: read what {{baseRef}} changed there (`git log -p HEAD..{{baseRef}} -- <file>`) and what this branch changed, then write the version that does both. Every export either side added stays; no duplicate definitions; one source of truth for anything both sides touch — never copy a function to make both compile. Check files git auto-merged for semantic breakage too (duplicate or contradicting rules, imports of something the other side renamed), not only for conflict markers. Never drop {{baseRef}}'s code to make a test pass, and never weaken or delete a test.
4. Verify: the Verifier above, plus the repo's typecheck and unit tests (where it has them: `npx tsc --noEmit`, `npx tsc --noEmit -p web`, `npx vitest run --maxWorkers=3`) and the Playwright `ui` project specs covering the conflicted files (`npx playwright test --project=ui --workers=2 <specs>`). Never run test:e2e:integration, test:e2e:vm or anything under e2e/integration. A failure: re-run it alone once, compare against a clean {{baseRef}} scratch worktree under your scratchpad (removed afterwards), and fix it only if the merge caused it.
5. Commit the merge (keep git's merge message, add a line naming the resolved files) and `git push` the branch. Confirm `gh pr view {{prNumber}} --json mergeable,headRefOid` reports MERGEABLE and that the head equals your push (UNKNOWN right after a push: read it again a few times before concluding).
6. Write a short {{taskDir}}/MERGE_NOTES.md: which files conflicted, how each was resolved, and what you ran with what result.
7. Do not merge the PR — merging stays the developer's own click.

## Safety rules
Never merge any PR. Never force-push or rebase a pushed branch. Never bind, stop or restart port 3030. Never kill processes by name. Never touch ORCHESTRATOR_SESSION / ORCHESTRATOR_TMUX, other tabs or other tmux sessions, and never send keys to any tmux session. Never write or overwrite the worktree's TASK.md. Write nothing to other tasks' directories.

## Output
The pushed merge commit and MERGE_NOTES.md.

## Session continuity (required)
When this session grows long, proactively suggest `/pipelinely-handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. While running, STATUS is `working` (Step 1). When the PR is MERGEABLE again and every check above is green, restore the STATUS the task had before this stage, verbatim: `{{previousStatus}}` — e.g. `echo "{{previousStatus}}" > {{taskDir}}/STATUS` — so the pipeline continues exactly where it stood. If a spec you could not fix is red, do not claim ready: `echo "waiting: merge conflicts resolved but <n> specs fail, needs the developer" > {{taskDir}}/STATUS`. If the conflicts themselves could not be resolved without a decision only the developer can make, `echo "waiting: merge conflicts need a decision: <what>" > {{taskDir}}/STATUS`. Then exit.

## Pipeline artifact reporting (required)
- **TIMELINE** — `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) merge-conflicts resolved PR #{{prNumber}} against {{baseRef}} (<files>)" >> {{taskDir}}/TIMELINE`

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.

## Branch (last line the dashboard reads)
- Branch: {{branch}}
<!-- brief-template:end -->
```

## Step 3 — Open the tab, but do not claim the pointers

Follow `orchestrator-prompt.md` step 4's shared tab-opening procedure ("Reusable form" subsection) with:
- `<tmux-name>`: `worker-<slug>-merge` · `<launch-script>`: `launch-merge.sh`
- Claim `ITERM_SESSION`/`TMUX_SESSION`: **no** — deliberately skip that part of the procedure. They must keep pointing at the dev tab, which the next stage returns to.
- Worktree: **reuse existing** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — no new worktree/branch
- Launch prompt: copy nothing into the worktree (the brief is read by absolute path, and this stage must leave the worktree's own `TASK.md` alone) and open with `"Read <resolved-tasks-dir>/<slug>/TASK-merge.md. BEFORE doing any task work: (1) rename this iTerm2 tab to '<slug>-merge' using osascript; (2) cd into ${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug> and complete the task from there."` — the tasks dir is the resolved one, never the hard-coded default root.
- `COCKPIT_STAGE`: `merge-conflicts`

## Step 4 — Track

`TaskCreate`, mark in_progress, add to the status board — note it as an ephemeral conflict-fix sub-session of the parent task.
