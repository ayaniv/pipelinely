# QA case list — parse mismatch fixture

## Workspace
- Repo: cockpit-ai
- Branch: claude/qa-parse-mismatch
- Branch status: new

## Mode: implement

## Context
Fixture task for the qa-case-list-automation e2e suite — not real work. Its
QA_REPORT.md deliberately declares one more "Passing Cases" bullet than it
actually lists, to exercise the parse-mismatch warning banner.
