# Working fanout parent fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/working-fanout-parent
- Branch status: existing

## Mode: implement

## Context
Fixture task for the design-v2 card follow-up e2e suite — not real work.

A milestone-declaring parent whose own STATUS is `working`. That combination
is what makes it the suite's one NON-PRIMARY footer card: `isFanoutParent`
keeps its footer (a parent's own session running says nothing about whether
its milestones need attention), while `attentionStatus: 'working'` is neither
`needs-you` nor `paused`, so `cardFooterHtml` renders its CTA without
`btn-primary`. Every other footer fixture is `waiting:`, i.e. primary.
