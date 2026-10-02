# blocked-approval-done fixture

## Workspace
- Repo: blocked-demo
- Branch: claude/blocked-approval-done
- Branch status: new

## Mode: implement

## Context
Fixture for e2e/dashboard-blocked-workers.spec.ts: a done task whose pane still shows a dialog — done tasks are never polled.
Its "live" tmux pane is e2e/fixtures/panes/worker-blocked-approval-done*.txt, served by
the fake tmux in e2e/fixtures/bin/tmux. Not real work.
