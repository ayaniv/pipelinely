---
name: cockpit-qa-fixes
description: Fixes the QA failures the developer checked off in QA_TRIAGE.json, re-verifies, and hands off to a fresh cockpit-qa re-run — continuing in this task's own existing dev tab rather than a fresh session, since fixing benefits from exactly the context a fresh QA reviewer deliberately doesn't have. Invoke directly inside the task's own tab as `/cockpit-qa-fixes`.
---

# Cockpit QA Fixes

Unlike every other `cockpit-*` skill, this one is **not** dispatched from the orchestrator into a new tab — it's invoked by the developer directly inside the task's own long-lived dev tab (reachable via the dashboard's → Terminal button, which `cockpit-qa` deliberately never repointed away from it). There is no `TASK.md`-writing or worktree/tab-creation step here; this skill's body runs in place.

## Step 1 — Read the triage selection

Read `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<this-task-slug>/QA_TRIAGE.json` and `QA_REPORT.md` to find which failing cases the developer checked. **This is `QA_TRIAGE.json`, not `TRIAGE.json`** — that file holds code-review findings for `cockpit-cr-fixes` instead; the two are deliberately separate sidecars since one task can carry both at once.

## Step 2 — Fix each checked case

For each checked failure, find and fix the root cause — don't just patch the symptom the test caught. Use `superpowers:systematic-debugging` for the investigation approach.

> **Assumption:** the design artifact this skill was built from refers to "the bugfix skill" without naming a concrete file, and no such skill exists in this repo today. `superpowers:systematic-debugging` is the closest existing match and is used here; flag this if a repo-specific bugfix skill gets added later.

## Step 3 — Re-verify locally

Re-run the verifier / e2e suite locally and confirm green before considering this done. Don't rely on the next QA pass to catch a fix that doesn't actually work.

## Step 4 — Commit, push, and report

1. Commit and push the fixes.
2. Update `QA_REPORT.md` (rewrite it, not append) to reflect which cases are now resolved — keep the same `### Failing Cases (N)` / `### Passing Cases (N)` bullet format `cockpit-qa` writes, **trailing location backtick-quoted** (`` - [Label] Description — `path/to/file.ts:42` ``), so the rewritten file parses exactly like a fresh QA pass would.
3. Append a `TIMELINE` line for stage `qa-fixes`.
4. Set `STATUS` to `waiting: fixes pushed, ready to re-run QA`.

## Step 5 — Hand back to QA

Don't grade your own fix by re-running the tests yourself and calling it done — that reintroduces exactly the "author is the worst judge" problem `cockpit-qa`'s fresh-session design exists to avoid. Leave `STATUS` at `waiting: fixes pushed, ready to re-run QA` and let the developer re-trigger `/cockpit-qa <slug>` for an independent re-check.
