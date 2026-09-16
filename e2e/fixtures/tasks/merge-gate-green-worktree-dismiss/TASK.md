# Merge gate fixture (merge-gate-green-worktree-dismiss)

## Workspace
- Repo: merge-gate-repo
- Branch: claude/merge-gate-green-worktree-dismiss
- Branch status: existing

## Mode: implement

## Context
Fixture task for e2e/cockpit-merge-gate.spec.ts — not real work. Its repo,
merge-gate-repo, is a plain directory under the fixture REPOS_DIR (not a git
checkout), so the fake gh on PATH has a real cwd to run in while any git
cleanup against it fails deterministically.
