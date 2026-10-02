# blocked-approval-noise fixture

## Workspace
- Repo: blocked-demo
- Branch: claude/blocked-approval-noise
- Branch status: new

## Mode: implement

## Context
Fixture for e2e/dashboard-blocked-workers.spec.ts: the pane has dialog-shaped text in scrollback and a grey suggestion at the prompt — must NOT read as blocked.
Its "live" tmux pane is e2e/fixtures/panes/worker-blocked-approval-noise*.txt, served by
the fake tmux in e2e/fixtures/bin/tmux. Not real work.
