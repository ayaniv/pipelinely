---
name: pipelinely-babysit
description: One sweep of the pipeline — sends the next stage for every task where that is safe (plan review, dev, code review, a recorded QA skip), one at a time and only while the machine load is low, then prints one "needs you" list of everything that is the developer's decision. Never merges, never starts QA without the recorded `qaStartPolicy`. Pairs with `/loop` for a schedule. Invoke from the orchestrator's own session as `/pipelinely-babysit [<slug>] [--except <slug>...]`. Do NOT open a new tab for yourself.
---

# Cockpit Babysit

**Hard stops — read this before doing anything else:**
- **Never merge.** Not through the merge skill, not through GitHub's merge command, however green a task is. Merging is the developer's click; a ready task is only listed.
- **Never start QA or an e2e run outside what `next` prints.** QA consent is the `qaStartPolicy` setting the CLI reads from `SETTINGS.json`, never anything said in the session, a task's auto-mode toggle, or a past approval you remember. If `next` does not print it, it does not run.
- **Never kill a session**, and never reuse a finished session's name by clearing it. The CLI hands out a fresh name instead.
- **Never answer a dispatched skill's question on the developer's behalf.** Whatever a skill this sweep runs would ask the developer (a weekly-focus "run it anyway or backlog it", a repo choice, onboarding, a confirmation), the sweep does not choose: it stops that task and lists it under needs-you.
- **Never write to a worker tab.** Only the orchestrator-side skills below are invoked; nothing is typed into a task's own tab.
- **Never edit STATUS, TIMELINE or `SETTINGS.json` by hand.** The CLI's `skip-qa` and `note` commands are the only writers here.
- **Conflicting PRs, review comments, QA findings and milestone parents are the developer's.** They appear in the report; this skill does not touch them.
- **Never push, never publish.** A sweep only opens worker tabs through the existing skills.

One call is one sweep. The decision behind every action is the shared one in `src/nextAction.ts`; this skill only runs what the CLI prints.

## Step 1 — Read the arguments

- No arguments: sweep every task.
- `<slug>`: sweep only that task. Pass it to every CLI call below as `--only <slug>`.
- `--except <slug>...`: leave the named tasks out entirely (the developer has asked to babysit everything except them). Pass it unchanged to every CLI call below.

Keep one list, `done`, of the slugs handled in this sweep (dispatched, skipped, failed or asked), one list, `failed`, of `<slug>=<reason>` pairs, and one list, `asked`, of `<slug>=<question>` pairs. All start empty.

## Step 2 — Loop, one action at a time

Run:

```
npm --prefix $HOME/Dev/pipelinely run --silent babysit -- next --done <comma-separated done slugs> [--only <slug>] [--except <slugs>]
```

The tasks dir it prints first on stderr is the real one; if it is not the dashboard's tasks dir, stop and tell the developer (a stale `TASKS_DIR` has leaked into this tab).

Read the exit code:

- **Exit `0`** — one JSON line on stdout: `{"slug","kind","stage","command"}`. Act on it (below), add the slug to `done`, and loop.
- **Exit `3`** — nothing is left to do. Go to Step 3.
- **Exit `4`** — held by load (`held: load <n>`). Go to Step 3 and say "held: load <n>" at the top of the report; do not wait or poll.
- **Exit `1`** — the CLI failed; its stderr says why. Print it, then go to Step 3. Do not guess what to do next.

Acting on an exit `0` line:

- `kind` is `dispatch`: invoke `/cockpit-<skill> <slug>` (the line's `command`). The skill opens the tab and writes `working` itself. **Then** record the outcome, the same order auto mode uses, so a TIMELINE line never claims a dispatch that did not happen:

  ```
  npm --prefix $HOME/Dev/pipelinely run --silent babysit -- note <slug> <stage>
  ```

  **Never answer a question that skill asks.** If it would ask the developer anything — the weekly-focus "run it anyway or backlog it", a repo choice, onboarding, a confirmation — stop that task there, choosing nothing for them. Record it with `note <slug> <stage> --failed 'asked: <question>'` and add `<slug>=<question>` to `asked` (passed to the report as `--asked '<slug>=<question>'`, which lists it under needs-you). Quote the question the same way as a failure reason below.

  If the dispatch failed (for example a tmux collision or an exit `1` or `3` from the tab-opening script), record that instead and **never retry it in the same sweep**:

  ```
  npm --prefix $HOME/Dev/pipelinely run --silent babysit -- note <slug> <stage> --failed '<short reason>'
  ```

  The reason is free text from a failed dispatch, so **single-quote it** and drop any single quote, `$` or backtick from it first; never paste raw error output into the command line. Add `<slug>=<short reason>` to `failed`. If `note` itself fails (exit `1`), print its stderr, still add the slug to `done` and `failed`, and carry on: a missing note only means the next sweep may see the task again, and the dispatch is never repeated in this one.
- `kind` is `skip-qa`: run the next command. It refuses (exit `2`) unless the shared decision says QA is not applicable; on a refusal, add the slug to `failed` and move on.

  ```
  npm --prefix $HOME/Dev/pipelinely run --silent babysit -- skip-qa <slug>
  ```

Each loop re-reads the load, the settings and every PR's merge state, so a merge or a finished dispatch since the last call is seen. At most one QA is sent per sweep, and none while another is running; the CLI enforces both.

## Step 3 — Report

Run:

```
npm --prefix $HOME/Dev/pipelinely run --silent babysit -- report --done <comma-separated done slugs> [--failed '<slug>=<reason>' ...] [--asked '<slug>=<question>' ...] [--only <slug>] [--except <slugs>]
```

Print its output verbatim. That printout is the whole of this skill's output: what moved, what failed, the single "needs you" list, and what was deferred and why. Add nothing to it, and do not act on the needs-you list.

## Scheduling

One call is one sweep, and a sweep that finds nothing exits `3` at once, so it pairs with `/loop`: `/loop 15m /pipelinely-babysit`.
