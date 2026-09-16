# Mark done (no worktree) fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/mark-done-no-worktree
- Branch status: existing

## Mode: implement

## Context
Fixture task for the merge-tab-actions e2e suite — not real work. Kept
separate from merge-ready (which other tests in the same suite read
concurrently) since this one gets its STATUS mutated to "done" mid-test.
