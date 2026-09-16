# No-repo fixture

## Workspace
- Branch: claude/filters-no-repo
- Branch status: new

## Mode: implement

## Context
Fixture for the smart-filters e2e suite: a task whose Workspace section
declares no `Repo:` line at all, so `task.repo` parses to the empty string.
It must never appear as a blank option in the project filter, and it must
stay visible while no project is selected. Not real work.
