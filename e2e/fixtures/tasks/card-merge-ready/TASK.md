# Card merge-ready fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/card-merge-ready
- Branch status: existing

## Mode: implement

## Context
Fixture task for the card-merge-cta e2e suite — not real work.

The one fixture that actually reproduces a real clean-QA handoff: STATUS and
TIMELINE and QA_REPORT.md all written in the same breath, exactly as
pipelinely-qa's own Status/Pipeline-artifact steps write them on a clean pass.
Every pre-existing "QA passed, ready to merge" fixture (merge-ready,
merge-gate-*, mark-done-*) instead ends its TIMELINE at 'code-review' with no
QA_REPORT.md at all, so none of them computes stage 'merge' — which is why
this suite needs its own fixture rather than reusing one of those.
