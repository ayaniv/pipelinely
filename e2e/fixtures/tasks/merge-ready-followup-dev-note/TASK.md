# Merge ready, follow-up dev note fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/merge-ready-followup-dev-note
- Branch status: existing

## Mode: implement

## Context
Fixture task for the merge-tab-actions e2e suite — not real work. Covers
findPrNumber's walk-backward fix: TIMELINE's latest 'dev' note is a
follow-up on the same PR with no PR reference of its own, so Open PR must
still resolve to the earlier note's PR #42.
