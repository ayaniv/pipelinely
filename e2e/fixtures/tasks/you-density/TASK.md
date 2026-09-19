# You-tab density fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/you-density
- Branch status: new

## Mode: implement

## Context
Fixture task for e2e/you-tab.spec.ts. The only done fixture whose per-session
METRICS files the spec writes at runtime, because the heatmap's day cells key
off `session.startedAt` and a checked-in absolute date would eventually fall
out of the chart's own rolling 53-week window. Every METRICS-*.json here is
written and removed by that spec, never committed. Not real work.
