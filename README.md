# Pipelinely

A local dashboard + workflow orchestrator for running a fleet of Claude Code
worker agents through a real staged pipeline — Planning → Plan Review → Dev →
QA → QA fixes → Code Review → Comment fixes → Merge — each stage its own
isolated worker in its own git worktree and its own tmux session/iTerm2 tab.
The dashboard shows every task's live stage, context %, token cost, and a
one-click jump back to its terminal; the orchestrator never does task work
itself, it only dispatches.

> macOS + iTerm2 only — tab dispatch and the → Terminal focus use AppleScript
> against iTerm2. Sessions run in tmux underneath, so they survive a closed
> tab or a sleeping machine and can be reattached from anywhere (e.g. over
> Tailscale + `tmux attach`), even though the dashboard's own UI is local-only.

## Prerequisites

- macOS + iTerm2
- [tmux](https://github.com/tmux/tmux) — `brew install tmux`, or the
  [tmux installer](#dotfiles) below
- Node 20+
- [`gh`](https://cli.github.com/), authenticated (`gh auth login`)
- `jq`
- [Claude Code](https://claude.com/claude-code), with the **superpowers**
  plugin installed — the dev and qa-fixes skills invoke `superpowers:*`
  skills for TDD, worktrees, and code review
- the [plannotator](https://github.com/anthropics) CLI, if you want inline
  visual feedback on plans and PRs (see [Dotfiles](#dotfiles))

## What's in here

- **`src/`, `public/`** — the dashboard: an Express + SSE server
  (`src/server.ts`) and a single self-contained `public/index.html`. Watches
  the tasks directory and pushes live updates over `/events`.
- **`orchestrator-prompt.md`** — the orchestrator's behavior spec: dispatch
  rules, the weekly-focus gate, the `TASK.md` skeleton, milestone fan-out.
  The source of truth `pipelinely` loads.
- **`docs/engineering-constraints.md`** — the one file that defines what
  every dispatched task is required to do (test coverage, error logging,
  `data-testid` selectors, no duplication, follow existing conventions).
  Every `pipelinely-*` skill copies this verbatim into the `TASK.md` it writes —
  edit it once here to change what every future dispatch expects.
- **`docs/tech-design-template.md`** — the shape a `tech-design.md` should
  take; planning writes to this template, plan review holds it to it.
- **`.claude/skills/`** — the pipeline, one skill per stage plus three
  cross-cutting ones:
  - `pipelinely` — turns the current tab into the orchestrator.
  - `pipelinely-planning` — explores the repo, decides milestones vs. flat,
    writes `tech-design.md` + e2e tests, in a fresh Opus 5 session.
  - `pipelinely-plan-review` — a *different*, fresh Opus 5 session that has
    never seen the plan reviews it cold and revises it in place.
  - `pipelinely-dev` — TDD implementation through to an opened PR, in its own
    long-lived tab (refuses to start a milestone whose `needs:` dependency
    hasn't merged yet).
  - `pipelinely-qa` — a fresh session runs the e2e tests planning wrote against
    the live PR and writes `QA_REPORT.md`. Never the dev's own tab or
    session — the code's author is the worst judge of whether it works.
  - `pipelinely-qa-fixes` — fixes the failures the developer checked off,
    re-verifies, hands back to a fresh `pipelinely-qa` re-run. Runs *in* the
    dev's own tab, deliberately, since fixing benefits from the context a
    fresh QA session doesn't have.
  - `pipelinely-cr` — a fresh session runs its own diff-based code review
    against the PR (a built-in review — `gh pr diff` plus
    `docs/engineering-constraints.md`) and persists it to
    `task-pr-review.md`. Same independence rule as QA.
  - `pipelinely-cr-fixes` — fixes the review comments checked off in
    `TRIAGE.json`, pushes, and annotates which comments were skipped.
  - `pipelinely-handover` — end-of-session transfer: writes continuation
    context and opens a fresh tab that auto-resumes the task.
  - `pipelinely-feedback` — files what you tell it as a GitHub issue on this
    repo via `gh issue create`, with a short summary of what you were doing
    right before it. Try `/pipelinely-feedback <what's wrong>`.

### Want a more thorough, team-specific reviewer?

`pipelinely-cr`'s built-in review is generic on purpose. For a deeper,
team-specific self-review step, start from
[`ayaniv/t2a-review-template`](https://github.com/ayaniv/t2a-review-template)
and wire it in as your own review skill.

## Quick start

One command clones the repo (skipped if you already have it), installs
dependencies, symlinks the pipeline skills into `~/.claude/skills/` (see
below — no manual loop needed), and runs whichever optional [dotfiles
installers](#dotfiles) their required binary is already on your `PATH`:

```bash
curl -fsSL https://pipelinely.cc/install.sh | sh
```

`PIPELINELY_DIR` overrides where it clones to (defaults to
`~/Dev/pipelinely`). Safe to re-run any time — it always picks up your
latest checkout. Or do it by hand:

```bash
git clone https://github.com/ayaniv/pipelinely.git ~/Dev/pipelinely
cd ~/Dev/pipelinely
npm install
npm start          # dashboard at http://localhost:3030 (npm run dev for watch mode)
npm test           # vitest
npm run test:e2e             # playwright, local/UI subset only (e2e/, minus e2e/integration/)
npm run test:e2e:integration # the real-integration subset (e2e/integration/) — asks for explicit confirmation first
```

`npm run test:e2e` never opens a real iTerm2 window or touches the developer's
real orchestrator session — the specs that do (real `osascript`/tmux, real
`ORCHESTRATOR_SESSION`) live in `e2e/integration/` and structurally refuse to
run without a freshly-granted consent token. `npm run test:e2e:integration`
(`scripts/e2e-integration/run.sh`) is the only way to grant one: it prints a
warning naming every spec about to run, on THIS Mac, for real, and requires an
explicit `y` at an interactive prompt — the confirmation is informed consent,
not authentication, and it expires with the shell that granted it (see
`src/e2eIsolation.ts`). In a **worktree** (not the canonical `~/Dev/pipelinely`
checkout), `npm run dev`/`npm start` also now need an explicit `TASKS_DIR` —
run either `TASKS_DIR=<worktree>/e2e/fixtures/tasks npm run dev` for a scratch
preview against fixture data, or `TASKS_DIR=~/Dev/pipelinely/tasks npm run dev`
to deliberately point at real data.

The skills under `.claude/skills/` are **project skills** — Claude Code
auto-discovers them when you work in this repo. `install.sh` already
symlinks them into your global skills dir for you; doing it by hand looks
like:

```bash
for s in .claude/skills/*/; do
  n=$(basename "$s")
  ln -sfn "$PWD/$s" ~/.claude/skills/"$n"
done
```

Then run `/pipelinely` in a dedicated tab and start dispatching —
either free-text ("build X") or `/pipelinely-planning <backlog item>` to go
straight into the pipeline.

## Dotfiles

Two optional installers under `dotfiles/`, alongside the existing
`dotfiles/claude-statusline/`:

- `dotfiles/tmux/install.sh` — installs a tmux config tuned for Claude Code
  (a memorable prefix, mouse support, and forwarding modified keys like
  Shift+Enter through to the running app). Backs up any existing
  `~/.tmux.conf` first.
- `dotfiles/plannotator/install.sh` — installs the three plannotator skills
  (`plannotator-annotate`, `plannotator-last`, `plannotator-review`) into
  `~/.claude/skills/`. Backs up any differing existing skill outside
  `~/.claude/skills/` first, so Claude Code never discovers the backup as a
  second skill with the same name.

Both refuse to run, with an install hint, if their required binary (`tmux`,
the `plannotator` CLI) isn't on `PATH` yet.

## Learn more

How the pipeline stages work, the dashboard's own UI, the full skills
reference, every configuration env var, and the task directory layout all
live in the [user guide](https://pipelinely.cc/docs) — kept in one place so
it can't drift out of sync with this README.

## Community Toolbox

A small curated list of skills, plugins and tools that fit an agentic pipeline
lives at [pipelinely.cc/toolbox](https://pipelinely.cc/toolbox). To add one, see
[CONTRIBUTING.md](CONTRIBUTING.md#add-to-the-toolbox).

## License

MIT — see [LICENSE](LICENSE).
