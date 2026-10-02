---
name: pipelinely-cr
description: Dispatches an independent, fresh code-review pass against a task's already-open PR — reads the PR's intent and diff and reviews it directly, then persists its report to task-pr-review.md. Same independence rule as pipelinely-qa — a fresh session, never claiming the task's ITERM_SESSION/TMUX_SESSION. Invoke from the orchestrator's own session as `/pipelinely-cr <milestone-or-task-slug>`. Do NOT open a new tab for yourself.
---

# Cockpit CR

What this stage checks is fully owned here — the mechanical *how a tab gets opened* is the one thing shared with every other pipeline dispatch, via `orchestrator-prompt.md` step 4's "Reusable form" (see Step 3 below). Mirrors `pipelinely-qa`'s shape exactly, for code review instead of functional testing: fresh, ephemeral session; author is the worst judge of their own code; never steals the dev tab's terminal pointer.

## Step 1 — Confirm there's something to review

Check that the task has an open PR (its PR link, wherever the task dir records one). If there's no PR yet, report that and stop.

## Step 2 — Render `TASK-cr.md`

Run `npm --prefix $HOME/Dev/pipelinely run --silent stage-brief -- code-review <slug> <PR>`, with the PR found in Step 1. It writes `<tasks-dir>/<slug>/TASK-cr.md` from the template below and prints that path. If it exits non-zero, report its one stderr line and stop — don't hand-write the brief.

Never write or overwrite `TASK.md` here: it is the dev tab's own brief. The renderer takes only files as input (the task's `INTENT.md`, plan, `VERIFY`, the prior review report and the worktree's git history), so the reviewer judges the PR against what the developer asked for, never against the PR body the dev worker wrote.

The template the renderer fills. `{{…}}` placeholders are a closed set it owns; everything else is verbatim.

```
<!-- brief-template:start -->
# {{title}} — code review

## Workspace
- Repo: {{repo}}
- PR: #{{prNumber}}
- Worktree: {{worktree}}
- Branch status: existing

## Mode: verify
Fresh, independent code-review pass against an already-open PR. Judge the PR against the developer's ORIGINAL intent below, not against the PR description.

## Intent (read these first)
{{intentBlock}}
- Approved plan: {{planLine}}
- Verifier: {{verifyLine}}
{{priorReviewBlock}}

## Do not read
{{doNotRead}}
They carry the implementation session's reasoning; this review must not inherit it.

## Steps
1. `cd` into the same existing worktree at {{worktree}} — no new worktree or branch.
2. Read the Intent files above, then `gh pr diff {{prNumber}}` for the change and `gh pr view {{prNumber}} --json title,body,baseRefName,headRefName` — the title and body are the author's CLAIMS to check, never the intent.
3. Read `docs/engineering-constraints.md` from the repo under review if it exists, otherwise from this checkout. Review the diff for correctness bugs, missing or weak tests (both happy and failure paths), silent failures, security issues, and violations of those constraints and of the repo's existing conventions. Read the surrounding code wherever the diff alone isn't enough to judge.
4. Intent check against INTENT.md: for every acceptance criterion, every out-of-scope line and (for a milestone) the milestone scope, decide satisfied, partial, not met or out-of-scope violated. With no criteria stated, judge against the request text plus the approved plan. Each gap is a finding: `- [Intent] <criterion> — <what is missing> — `INTENT.md:<line>``. It is Must Fix when not met or an out-of-scope line is violated, Should Fix when partial.
5. Divergence check: any PR-body claim the diff doesn't back, and any behaviour the diff adds that INTENT.md doesn't ask for, is a finding: `- [Intent drift] <what> — `<file>:<line>``. It is Should Fix unless it breaks a criterion.
6. Write the report **verbatim** to {{taskDir}}/task-pr-review.md (the tasks dir, **not** the worktree — the dashboard only reads from the tasks dir), following the example report in the pipelinely-cr skill exactly: `### Must Fix (N)` / `### Should Fix (N)` / `### Suggestions (N)` bullets and `**Verdict: APPROVED**` / `**Verdict: CHANGES REQUIRED**`. **Every bullet's trailing location MUST be backtick-quoted**, e.g. `- [Category] Description — `path/to/file.ts:42``. Put this line directly above the verdict: `**Intent: SATISFIED | PARTIAL | NOT MET | NO RECORDED INTENT**`.
7. Do not attempt fixes — that's `pipelinely-cr-fixes`'s job, deliberately in a different session.

## Output
`task-pr-review.md`.

## Session continuity (required)
When this session grows long, proactively suggest `/pipelinely-handover` before context degrades.

## Status reporting (required)
Write by **absolute path**. When done: `echo "waiting: CR found <n> must-fix comments, triage and dispatch cr-fixes" > {{taskDir}}/STATUS` if CHANGES REQUIRED, or, if APPROVED with no comments at all, `echo "waiting: CR approved, ready for QA" > ...`. That marker is the hand-off even when QA turns out not to apply — the dashboard and `/pipelinely-qa` decide that from `VERIFY` and the diff (`assessQaNeed`), so do not reword it. If APPROVED but the review still lists any should-fix/suggestion comment, write `echo "waiting: CR approved with comments, triage and dispatch cr-fixes" > ...` instead, so STATUS itself says QA is not next. (The dashboard also derives this from the parsed comment count, so tasks already on disk with the old QA wording route to cr-fixes too.) Then exit.

## Pipeline artifact reporting (required)
- **TIMELINE** — `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) code-review <verdict note>" >> {{taskDir}}/TIMELINE`

## Metrics reporting (required)
Periodically run `bash ~/Dev/pipelinely/scripts/write-metrics.sh` so the dashboard's CTX/MODEL/TOKENS/COST tiles stay live.

## Branch (last line the dashboard reads)
- Branch: {{branch}}
<!-- brief-template:end -->
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
- Claim `ITERM_SESSION`/`TMUX_SESSION`: **no** — deliberately skip that part of the procedure. They must keep pointing at the dev tab, which `pipelinely-cr-fixes` returns to.
- Worktree: **reuse existing** at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>` — no new worktree/branch
- Launch prompt: copy nothing into the worktree (the brief is read by absolute path, and this stage must leave the worktree's own `TASK.md` alone) and open with `"Read <resolved-tasks-dir>/<slug>/TASK-cr.md. BEFORE doing any task work: (1) rename this iTerm2 tab to '<slug>-cr' using osascript; (2) cd into ${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug> and complete the task from there."` — the tasks dir is the resolved one, never the hard-coded default root.
- `COCKPIT_STAGE`: `code-review`

## Step 4 — Track

`TaskCreate`, mark in_progress, add to the status board — note it as an ephemeral CR sub-session of the parent task.
