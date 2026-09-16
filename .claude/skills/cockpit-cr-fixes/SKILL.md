---
name: cockpit-cr-fixes
description: Fixes the code-review comments the developer checked off in TRIAGE.json, pushes, and annotates task-pr-review.md so unchecked comments are recorded as deliberately skipped rather than silently dropped — continuing in this task's own existing dev tab, not a fresh session. Invoke directly inside the task's own tab as `/cockpit-cr-fixes`.
---

# Cockpit CR Fixes

Mirrors `cockpit-qa-fixes`'s shape: invoked by the developer directly inside the task's own long-lived dev tab, not dispatched from the orchestrator. No `TASK.md`-writing or worktree/tab-creation here.

## Step 1 — Read the triage selection

Read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<this-task-slug>/TRIAGE.json` and `task-pr-review.md` to find which review comments the developer checked. **This is `TRIAGE.json`, not `QA_TRIAGE.json`** — that file holds QA-failure selections for `cockpit-qa-fixes` instead; the two are deliberately separate sidecars since one task can carry both at once.

## Step 2 — Bring the branch up to date with its base first

A dev branch can sit open for a while between when it was cut and when CR fixes actually land — long enough for its base branch to move well ahead in a repo where other work keeps merging. Fixing review comments on stale code just re-creates the same conflict at merge time, so resolve that first:

1. Find the base branch (`gh pr view --json baseRefName`, or `git remote show origin | grep 'HEAD branch'` if there's no open PR reference handy).
2. `git fetch origin <base>`, then check how far behind: `git log --oneline HEAD..origin/<base> | wc -l`. If it's 0, skip the rest of this step.
3. If behind, `git merge origin/<base>` (merge, not rebase — this branch may already be reviewed against its current history, and a rebase would rewrite commits a CR pass already looked at). Resolve any conflicts for real — read both sides, don't blindly take one; this is the same code the CR pass already validated, so preserve its actual behavior through the merge, not just a mechanical conflict-marker resolution.
4. Run the repo's verifier (`VERIFY`'s first line) after resolving, before moving on to Step 3 — a clean merge that silently reintroduces a bug the merged-in commits fixed is worse than the conflict itself.

## Step 3 — Fix checked comments, leave unchecked ones on record

1. For each checked comment, make the fix it asks for.
2. For each comment left **unchecked**, do not silently drop it — write it back into `task-pr-review.md` annotated as deliberately skipped (e.g. append a short note under the finding: `Skipped — <one-line reason if the developer gave one, otherwise "left unaddressed by developer choice">`). The record should show every comment was seen, not just the ones acted on. Leave the finding's own bullet line untouched when doing this — same `### Must Fix (N)` / `### Should Fix (N)` / `### Suggestions (N)` format `cockpit-cr` writes, trailing location still backtick-quoted (`` - [Category] Description — `path/to/file.ts:42` ``); the "Skipped — ..." note is a separate line under it, not a rewrite of the bullet itself.

## Step 4 — Commit, push, and report

1. Commit the fixes and push (the merge commit from Step 2 goes along with this push, or push it separately first if you already committed it standalone).
2. Rewrite `task-pr-review.md` (not append) with the annotated state from Step 3 — same backtick-quoted bullet format throughout, not just the untouched findings.
3. Append a `TIMELINE` line for stage `comment-fix` — note if a base-branch merge was needed.
4. Set `STATUS` to `waiting: comments addressed, ready for QA`.

## Step 5 — Hand off to QA

CR runs before QA in this pipeline (Dev → CR → CR fixes → QA → QA fixes → Merge), so once the review comments are addressed the next automated step is a fresh `cockpit-qa` pass against the fixed code — not a straight shot to manual merge. `cockpit-cr` itself doesn't get re-triggered automatically; if the developer wants a second CR pass after a substantial fix, they can re-trigger `/cockpit-cr <slug>` themselves before QA runs. Leave `STATUS` at `waiting: comments addressed, ready for QA` and let the developer (or the orchestrator) trigger `/cockpit-qa <slug>` next.
