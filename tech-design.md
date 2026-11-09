# Start each worker's claude session inside its worktree

**Author:** Yaniv Aharon (planning session)
**Date:** 2026-11-09

## Summary

Each worker's `launch.sh` now prepares or finds the task's worktree before it starts `claude`, and starts `claude` in that worktree, not in the task dir. A new CLI, `npm run worker-start-dir`, does the git work in the worker's own tab. It prints the directory to start in. If the setup fails, it stops with a visible error and writes the cause to `STATUS` and `TIMELINE`. With this change, a plain `git commit`, `git push` and `gh pr create` run from the worktree: the Neo core hook sees a linked worktree, the user's allow rules match, and the target repo's `.claude/` loads.

**QA Spec:** e2e/worker-start-dir.spec.ts

## Shape

Flat. The CLI, the launch template, the stage skills and `write-metrics.sh` are one change. A template that calls a CLI that does not exist is not shippable, and the CLI has no other user. There are no milestones.

## Verifier

```
npm test && npx playwright test --project=ui e2e/worker-start-dir.spec.ts e2e/repos-root-and-lazy-onboarding.spec.ts
```

Until dev starts, the new spec is red (21 of 22 fail; see "Red state"). `repos-root-and-lazy-onboarding.spec.ts` has 2 failures on `main` today (see "Existing failures"). Dev fixes both.

## Current state (explored)

- `orchestrator-prompt.md` step 4 holds the one `launch.sh` template. It does `cd "<resolved-tasks-dir>/<task-slug>"` and then `exec claude "Read TASK.md. … (2) create the worktree … (3) copy TASK.md … (4) cd to the worktree …"`. The worker runs the git commands from its Claude session, and the session cwd stays the task dir. The task dir is inside the pipelinely checkout, which is on `main`.
- The "Reusable form" table in step 4 gives each stage its values. The worktree row has three cases: new (planning, dev on a new branch), reuse (plan-review, qa, design-qa, cr, merge-conflicts, dev on an existing worktree) and none (adopt). The reuse case has a `cp TASK.md` refresh note. cr and merge-conflicts copy nothing and read `TASK-cr.md` / `TASK-merge.md` by absolute path.
- Stage skills only give their values: `pipelinely-planning`, `-plan-review`, `-dev`, `-qa`, `-design-qa`, `-adopt` (worktree: none), and `-cr` and `-merge-conflicts`, each with its own "Launch prompt" line that says `cd into ${WORKTREES_DIR…}`.
- `pipelinely-handover` step 6b has its own launch template (`launch-handover-<N>.sh`): `cd` to the task dir, then a prompt that says "cd to the worktree".
- `src/focusTab.ts` writes `launch-annotate.sh` (plannotator on `tech-design.md` in the task dir). That is not a code stage. It does not change.
- `scripts/dispatch-tab.sh` runs in the orchestrator. It writes `working` to `STATUS`, opens the tab, waits for an ack file that the typed tmux command touches **before** `launch.sh` runs, and then claims `ITERM_SESSION`/`TMUX_SESSION`. Because the ack comes before `launch.sh`, nothing that `launch.sh` does can change what dispatch-tab sees.
- `scripts/write-metrics.sh` finds the transcript at `~/.claude/projects/$(pwd | sed 's/\//-/g')/<session>.jsonl`. That works today only because the Bash tool resets its cwd to the start dir when the worker `cd`s outside it. Claude Code also changes `.` to `-` (for example `-Users-yaharon-Dev-operator--claude-worktrees-…`), which the `sed` does not do. A worker that starts in a worktree and `cd`s into a subdir (`web/`) gets a wrong folder.
- `src/bookmarksTranscript.ts` `findTranscriptPath` already searches every project folder for `<session>.jsonl`. It needs no change.
- `src/gitOps.ts` `resolveBaseRef` already finds a fork base from `origin/HEAD`, `origin/master`, `origin/main`, `master`, `main`.
- `src/stageBrief.ts` reads `<worktree>/TASK.md` as one intent source. `pipelinely-handover` step 1 looks for `TASK.md` in the current dir. So the worktree copy of `TASK.md` stays.

## Design

### 1. `worker-start-dir` CLI (new)

Files: `src/workerStartDir.ts` (logic), `src/workerStartDirCli.ts` (argv, exit code), `package.json` script `"worker-start-dir": "tsx src/workerStartDirCli.ts"`. Unit tests in `src/workerStartDir.test.ts` (vitest, real git in temp dirs, the same pattern as `scripts/dispatch-tab.test.ts`).

```
npm --prefix "$HOME/Dev/pipelinely" run --silent worker-start-dir -- \
  --task-dir <abs task dir> --repo <repo> --branch <branch> \
  --worktree create|reuse|none [--copy-task-md]
```

- Slug = `basename(--task-dir)`. Repo checkout = `$REPOS_DIR/<repo>` (launch.sh exports `REPOS_DIR`). Worktree = `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>`. launch.sh unsets `WORKTREES_DIR`, so a worker uses the default, the same as today.
- stdout: one line, the absolute directory to start in. Nothing else goes to stdout.
- `none`: prints the task dir. It runs no git. (adopt: the merge removed the worktree. The task dir is the start dir, as today. We do not start in the primary checkout, because a session there could commit to the default branch.)
- `reuse`: the worktree must exist and be a worktree of the repo on `<branch>`. Else, fail. It never creates a worktree, because a missing worktree at qa/cr time is a problem that a person must look at.
- `create`, in this order:
  1. If the worktree path exists: it must be a git worktree whose checked-out branch is `<branch>`. If so, use it (dev continuing after planning, re-dispatch). If not (another branch, or a plain dir), fail and change nothing.
  2. `git -C <repo> fetch origin`. If the fetch fails, fail. A stale base is worse than a stop with a visible cause.
  3. If `refs/heads/<branch>` exists: `git -C <repo> worktree add <path> <branch>`.
  4. Else, if `refs/remotes/origin/<branch>` exists: `git -C <repo> worktree add -b <branch> <path> origin/<branch>`.
  5. Else: base = `resolveBaseRef(<repo>)` (reuse it, do not copy it). `git -C <repo> worktree add -b <branch> <path> <base>`. This covers `main` and `master`, and clones that have no `origin/HEAD`.
  No step runs `checkout` in the primary checkout. Its branch and HEAD do not change. (The old template did `checkout main && pull && checkout -b … && checkout main` in the primary checkout.)
- `--copy-task-md`: after the worktree is ready, copy `<task-dir>/TASK.md` to `<worktree>/TASK.md`. This replaces the prompt's old `cp` step and the "Reuse-worktree TASK.md refresh" note. cr and merge-conflicts do not pass it, so the worktree's own `TASK.md` stays as it is.
- Failure (any step, after the arguments are valid):
  - stderr: one line, `worker-start-dir: <cause>` (also `console.error` with the git stderr, for the log).
  - `STATUS` ← `waiting: worktree setup failed — <cause>` (by absolute path).
  - `TIMELINE` ← `<ISO-8601 UTC> <COCKPIT_STAGE or "dispatch"> worktree setup failed: <cause>`.
  - exit 1, empty stdout.
- Bad arguments (unknown `--worktree` value, a relative `--task-dir`, a missing flag): stderr line, exit 2, no `STATUS`/`TIMELINE` write, no git.

**Decision: write a `waiting:` STATUS. Do not restore the old STATUS.** TASK.md asks for a restore "like dispatch-tab's failure path". But dispatch-tab has already returned and claimed the pointers when `launch.sh` runs, and the previous value is not available in the tab. Also, a restore would show the previous stage's text (for example `waiting: plan ready for review`) and hide the failure. The `waiting: worktree setup failed — …` line puts the card in the developer's "needs you" list with the cause. The plan reviewer can overrule this.

### 2. The one shared launch template (`orchestrator-prompt.md` step 4)

New template (the spec fills `<worktree-flags>` and runs it):

```bash
#!/bin/bash
unset REPOS_DIR TASKS_DIR WORKTREES_DIR PIPELINELY_REMOTE_TOKEN_FILE BROWSER PLAYWRIGHT_TEST COCKPIT_TASK_SLUG COCKPIT_STAGE
export REPOS_DIR='<resolved-repos-dir>'
export COCKPIT_TASK_SLUG=<task-slug>
export COCKPIT_STAGE=<stage>
START_DIR="$(npm --prefix "$HOME/Dev/pipelinely" run --silent worker-start-dir -- --task-dir "<resolved-tasks-dir>/<task-slug>" --repo "<repo>" --branch "<branch>" <worktree-flags>)" || exec bash -l
cd "$START_DIR" || exec bash -l
exec claude "Read <resolved-tasks-dir>/<task-slug>/TASK.md. This session starts in the task's worktree (for a stage with no worktree, in the task dir). BEFORE doing any task work: (1) rename this iTerm2 tab to '<task-slug>' using osascript; (2) complete the task from this directory, and run git, gh and npm here without cd or git -C."
```

- The tool path is `$HOME/Dev/pipelinely`, the same as `dispatch-tab.sh` and `write-metrics.sh`. It is not under `REPOS_DIR` (the existing contract test "no skill or prompt still locates the tool checkout under the configurable repo root" requires this).
- `|| exec bash -l`: if the setup fails, the tab stays open with the error on screen, and `claude` does not start. If `launch.sh` exited instead, tmux would close the tab and the error would be lost.
- The worker prompt reads the brief by absolute path. It has no `git worktree add`, no `cp` and no `cd`.
- Update the prose after the template: remove the `\$` escaping paragraph and the old git-flow text, and explain the start-dir step and the failure path. In the "Reusable form" table, change the "Worktree" row to the `<worktree-flags>` value for each column:

| Stage | `<worktree-flags>` |
|---|---|
| ad-hoc code task, `pipelinely-planning`, `pipelinely-dev` | `--worktree create --copy-task-md` |
| `pipelinely-plan-review`, `pipelinely-qa`, `pipelinely-design-qa` | `--worktree reuse --copy-task-md` |
| `pipelinely-cr`, `pipelinely-merge-conflicts` | `--worktree reuse` (prompt reads `TASK-cr.md` / `TASK-merge.md` by absolute path) |
| `pipelinely-adopt`, ad-hoc research task with no repo | `--worktree none` |

  For `--worktree none` with no repo, the template still passes `--repo`/`--branch`. The CLI ignores them in `none` mode. Replace the "Reuse-worktree `TASK.md` refresh" note with one sentence: `--copy-task-md` does that refresh on every dispatch.
- `pipelinely-dev` no longer needs the "new vs reuse" fork from its Step 1 filesystem check. `create` finds an existing worktree. Keep the Step 1 check only if it gates something else.

### 3. Stage skills

Each skill keeps only its values (the existing rule in step 4). Change:

- `pipelinely-planning`, `-dev`: `Worktree:` line → `--worktree create --copy-task-md`.
- `-plan-review`, `-qa`, `-design-qa`: → `--worktree reuse --copy-task-md`.
- `-cr`, `-merge-conflicts`: → `--worktree reuse`. In the "Launch prompt" line, remove `(2) cd into ${WORKTREES_DIR…}` and keep "Read `<resolved-tasks-dir>/<slug>/TASK-cr.md`" (or `TASK-merge.md`).
- `-adopt`: → `--worktree none`.
- `pipelinely-handover` 6b: use the same start-dir line with `--worktree reuse` (no `--copy-task-md`). The successor reads `<resolved-tasks-dir>/<slug>/TASK.md` and `…/HANDOVER-<N>.md` by absolute path. Add the `unset` line and `COCKPIT_STAGE` from the shared template, so the handover tab gets the same environment as a dispatch. The handover writes `<repo>` and `<branch>` from the task's `TASK.md` `## Workspace`.
- `.claude/skills/pipelinely/SKILL.md` and `pipelinely-babysit` hold no copy of the launch prompt (checked at planning). They do not change.

### 4. `write-metrics.sh`

Find the transcript by session id in any project folder: `~/.claude/projects/*/<session>.jsonl`, the first match. Session ids are UUIDs, so a match is unique. Keep the "transcript not found" error and exit 1 when nothing matches. This removes the `pwd`-based folder name, which fails for a subdir and for paths with `.`. Do not change `write-metrics.py`.

### 5. Things that do not change

- `dispatch-tab.sh`: the collision check, the `STATUS` write, the ack and the pointer claim stay the same. The ack file comes before `launch.sh`, so the git step in `launch.sh` does not delay or break the ack.
- All task-dir files (`STATUS`, `TIMELINE`, `VERIFY`, `METRICS`, `tech-design.md`) are already written by absolute path in every brief.
- The Neo core plugin hook and `~/.claude/settings.json`: no change (TASK.md).
- Per-repo worktree scripts (operator `./scripts/worktree-dev.sh`): no special case. `git worktree add` works for operator today.

## Existing failures (fix in this task)

`e2e/repos-root-and-lazy-onboarding.spec.ts` reads `.claude/skills/handover/SKILL.md`, but the folder is `pipelinely-handover`. 2 tests fail on `main` for that cause. Also, after this change its `runLaunchScript` would run the real `npm --prefix $HOME/Dev/pipelinely` with the real `HOME`, and that can create worktrees under the real `~/Dev/worktrees`. Dev must:

- change the path to `pipelinely-handover`;
- give `runLaunchScript` a scratch `HOME` with `Dev/pipelinely` linked to the checkout under test (as `e2e/worker-start-dir.spec.ts` does), and fill `<worktree-flags>` with `--worktree none`, so that the test runs no git;
- remove the test "the worker prompt quotes every repo-root expansion", because the prompt no longer holds `git -C`. The CLI receives the paths as argv, and `worker-start-dir.spec.ts` covers this.

## Dev QA cases

All are in `e2e/worker-start-dir.spec.ts` (tagged `@pending`):

| Scenario | Expected |
|---|---|
| create, new branch, origin `main` moved ahead | worktree on `claude/<slug>` at the origin tip; `TASK.md` copied; primary checkout branch and HEAD unchanged; STATUS unchanged |
| create, origin default `master` | forks from `origin/master` |
| create, clone with no `origin/HEAD` | forks from `origin/main` |
| create, branch exists locally | that branch is checked out, not recreated |
| create, branch exists only on origin | checked out from `origin/<branch>` |
| create, worktree already on the branch | reused, no new worktree, `TASK.md` refreshed |
| reuse, worktree present, no `--copy-task-md` | located; its own `TASK.md` unchanged |
| reuse, worktree missing | fails: exit ≠ 0, stderr `worker-start-dir:`, STATUS `waiting: worktree setup failed…`, TIMELINE line, no dir created |
| none | prints the task dir; no git (repo checkout removed) |
| create, worktree dir on another branch | refused; that worktree unchanged |
| create, plain dir in the worktree spot | refused; its files unchanged |
| create, fetch fails | refused; no worktree |
| create, repo checkout missing | refused |
| bad `--worktree` value | refused; STATUS unchanged; no worktree |
| launch.sh (template), create | `claude` starts with cwd = the worktree; prompt has the absolute `TASK.md` path, no `worktree add`, no `cd to/into` |
| launch.sh (template), setup fails | `claude` never starts; STATUS says why |
| launch.sh (template), none (adopt) | `claude` starts in the task dir |
| handover launch script | successor starts in the worktree; reads `TASK.md` and `HANDOVER-2.md` by absolute path |
| doc contract | no skill or the orchestrator prompt tells a worker to `cd` into the worktree or run `worktree add` in its prompt |
| doc contract | each stage skill names its `--worktree` mode |
| write-metrics, transcript folder with `--`, run from a subdir | `METRICS` and `METRICS-<session>.json` written |
| write-metrics, no transcript | clear error, exit ≠ 0, no `METRICS` |

Unit tests (`src/workerStartDir.test.ts`, written red first by dev) cover the same branches at function level, plus: the TIMELINE stage falls back to `dispatch` when `COCKPIT_STAGE` is empty; a `--task-dir` with a space works.

Each test runs in scratch dirs with a scratch `HOME`. No test touches the dashboard on port 3030, `tasks/ORCHESTRATOR_SESSION`, tmux, osascript or the developer's real worktrees.

## Red state at planning

`npx playwright test --project=ui e2e/worker-start-dir.spec.ts`: 21 failed, 1 passed. The CLI tests fail with `npm error Missing script: "worker-start-dir"`. The template tests fail with `no bash launch template containing 'worker-start-dir' found`. The write-metrics subdir test fails with `transcript not found at …-some-sub.dir/…`. The test that passes is "no transcript anywhere → clear error", which already works and stays as a guard.

## Risks

- `npm` on the PATH of the tmux tab: `launch.sh` already needs `claude` on that PATH, and both come from the same Node install. If `npm` is missing, the start-dir line fails, the `|| exec bash -l` keeps the tab open, and the shell's own error shows the cause. `STATUS` stays `working` in that case only. This is acceptable, because no CLI can run to write it.
- Start-up time: `npm run` + `tsx` adds about 1–2 s, plus the fetch. The ack check is not affected.
- Tasks dispatched before this change keep their old `launch.sh`. Only new dispatches use the new template.
