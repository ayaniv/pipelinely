# Mark done (with worktree) fixture

## Workspace
- Repo: nonexistent-fixture-repo
- Branch: claude/mark-done-with-worktree-dismiss
- Branch status: existing

## Mode: implement

## Context
Fixture task for the merge-tab-actions e2e suite — not real work. Its repo
field deliberately names a repo with no real checkout under the fixture
REPOS_DIR, so /mark-done's cleanup step fails deterministically (a real
`git worktree remove` against a directory that isn't a git repo) rather
than needing a real git repo + merged branch set up just for this test.
