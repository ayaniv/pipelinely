# QA fixes activity fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/qa-fixes-activity
- Branch status: existing

## Mode: implement

## Context
Fixture task for the stepper-node-grouping e2e suite — not real work. Its
TIMELINE actually reaches 'qa-fixes' (unlike qa-fixes-ready, which is only
waiting to have it dispatched), so its stage chain has real QA-fixes activity
to fold into the QA node.
