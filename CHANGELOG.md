# Changelog

All notable changes to this project are logged here, one entry per merged
pull request, newest first. This file is auto-maintained: a GitHub Actions
workflow (`.github/workflows/update-changelog.yml`) appends a new entry
automatically whenever a PR merges into `main`. Manual edits to old entries
are safe — only new entries are appended.

History below September 2026 predates this repo's own public history —
this project was built and iterated on privately before being extracted
and open-sourced. The entries below are a hand-picked selection from that
private development history, going back to the first commit on 2026-06-27,
included so the arc of how this got built is visible rather than starting
from a blank slate.

## 2026-09-19

- [#3](https://github.com/ayaniv/pipelinely/pull/3) Add dispatch-tab.sh, card Merge CTA, You tab and /help feedback page

## 2026-09-16

- Scrubbed the private tree, added a leak-check gate, and built the
  publish script (path rewrite, public-only overlay, installers) that
  turned this into a publishable open-source project.

## 2026-09-13

- Added orchestrator auto mode: automatic advancement through pipeline
  stages that don't need a human decision.

## 2026-09-09 to 2026-09-12

- Full UI realignment across the dashboard's six milestone views (page
  frame, context meter, active tab/session card, backlog, task detail,
  milestone drill-down).

## 2026-09-05

- Added a `cockpit-merge` skill: gate merges on green CI + no conflicts,
  then clean up and mark the task done automatically.

## 2026-08-24

- UI redesign and rebrand milestone — introduced the pipelinely.cc
  identity.

## 2026-08-21

- Wired pipeline-stage CTAs so each stage's own dispatch button stages
  the right next command, plus a working Merge tab.

## 2026-08-19

- Shipped the full QA case list and a "Run QA automation" dispatch
  button.

## 2026-08-17

- Added the seven `cockpit-*` pipeline-stage skills, and this very
  changelog-automation mechanism.

## 2026-08-13

- Implemented the milestone fan-out: parsing a plan's declared
  milestones, wave-ordering dependent children, and giving each
  milestone its own stepper and per-stage tabs.

## 2026-08-04

- Added the pipeline-stages read layer (parsing VERIFY/TIMELINE/STATUS
  into an 8-stage pipeline) and dark mode.

## 2026-08-03

- Designed and shipped tmux-resilient orchestrator/worker tabs: named
  sessions, reattach-on-crash, orphan detection, and session-hijack-safe
  targeting.

## 2026-07-21

- Reorganized the dashboard into In Progress / Done / Backlog tabs.

## 2026-07-18

- Added orphan-task detection, a manual "done" override, and a
  weekly-focus banner.

## 2026-07-06

- Added a progress bar for multi-milestone projects and wired
  cost/token metrics into every dispatched session.

## 2026-07-05

- Started parsing milestone plans and serving them to the dashboard.

## 2026-06-30

- Generalized the orchestrator: made the tasks directory configurable
  instead of hardcoded, dropped tool-specific defaults in favor of a
  generic one, and added a README.

## 2026-06-28

- First visual overhaul: a dark, Vercel/Linear-style dashboard theme.

## 2026-06-27

- Scaffolded the project: task types and a parser, pricing/cost
  utilities, an Express server with SSE live updates, and the first
  dashboard UI.

## 2026-05

- Built the first Command Center: one dashboard to see what every agent
  was doing, instead of tracking state across a growing pile of terminal
  tabs. This is what eventually became Pipelinely.

## 2026-03

- Built the first orchestrator skill: a repeatable process for planning,
  developing, reviewing, and merging work through Claude Code agents,
  plus a handover mechanism to keep context fresh across long sessions.
