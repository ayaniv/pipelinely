# Design v2 priced done fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/design-v2-done-priced
- Branch status: new

## Mode: implement

## Context
Fixture task for the design-v2 alignment e2e suite. The ONLY done fixture
carrying a METRICS file, so it is the only row with a real cost — which is
what makes the Done group header's per-day spend total (the design's own
`g.total`, a sum over the group's visible rows) a non-zero number worth
asserting rather than a vacuous $0.00. Shares board-done-one's merge date so
it lands in the same date group as the unpriced rows, proving the sum spans
priced and unpriced rows alike. Not real work.
