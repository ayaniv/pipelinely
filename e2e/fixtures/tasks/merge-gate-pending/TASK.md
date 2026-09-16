# Merge gate fixture (merge-gate-pending)

## Workspace
- Repo: merge-gate-repo
- Branch: claude/merge-gate-pending
- Branch status: existing

## Mode: implement

## Context
Fixture task for e2e/cockpit-merge-gate.spec.ts — not real work. Its repo,
merge-gate-repo, is a plain directory under the fixture REPOS_DIR (not a git
checkout), so the fake gh on PATH has a real cwd to run in while any git
cleanup against it fails deterministically.
