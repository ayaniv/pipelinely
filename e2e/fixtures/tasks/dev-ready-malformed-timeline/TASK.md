# Dev ready (malformed TIMELINE) fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/dev-ready-malformed-timeline
- Branch status: existing

## Mode: implement

## Context
Fixture task for the pipeline-stage-cta e2e suite — not real work. Same
"waiting: plan reviewed, ready for dev" state as dev-ready, but its
TIMELINE's plan-review line has an unparseable timestamp, so
parseTimelineContent drops it entirely.
