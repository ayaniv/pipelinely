# CR fixes skip-target fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/cr-fixes-skip-target
- Branch status: existing

## Mode: implement

## Context
Fixture task for the Skip-button e2e test — kept separate from
cr-fixes-ready so skipping it (which mutates STATUS/TIMELINE) never
disturbs the other cr-fixes-ready assertions. The test restores this
fixture's STATUS/TIMELINE to their original content afterward regardless.
