# CR fixes activity fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/cr-fixes-activity
- Branch status: existing

## Mode: implement

## Context
Fixture task for the stepper-node-grouping e2e suite — not real work. Its
TIMELINE actually reaches 'comment-fix' (unlike cr-fixes-ready, which is only
waiting to have it dispatched), so its stage chain has real CR-fixes activity
to fold into the CR node.
