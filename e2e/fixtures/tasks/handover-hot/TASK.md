# Handover hot fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/handover-hot
- Branch status: existing

## Mode: implement

## Context
Fixture task for the handover-dispatch e2e suite — not real work.
Its METRICS reports a hot context (74% > CTX_HOT_THRESHOLD's 60), and its
STATUS is `paused:` (not `working`), so both the board card and the detail
header render a Handover pill. It deliberately has NO ITERM_SESSION and NO
TMUX_SESSION: an unstubbed POST /handover/handover-hot then resolves to
pasteIntoTrackedSession's pure no-session exit (no osascript, no tmux), so the
failure-path case can run against the real fixture server in the local-safe
`ui` project.

Its METRICS carries contextPct only — no tokens, no model — so it prices to
zero and adds nothing to the header spend total or any other priced
aggregate; board-metrics stays the only *priced* METRICS fixture, which
board-redesign.spec.ts, cockpit-ui-reconcile.spec.ts and
design-v2-active-board.spec.ts rely on.
