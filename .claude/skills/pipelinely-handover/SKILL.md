---
name: pipelinely-handover
description: End-of-session transfer — writes a continuation context, updates STATUS, and opens a new iTerm2 tab that auto-loads the new session. Use when context is getting long or the session is ending. /handoff is for mid-session copy-paste resets; /pipelinely-handover is for full automated tab transfer.
allowed-tools: ["Bash", "Write", "Read"]
---

# Handover

Transfer this session to a fresh Claude tab. Do this yourself — do NOT delegate to a subagent. Subagents have no access to this conversation's context.

## Paths

Task state lives under the **tasks directory**, which must match what the Pipelinely server watches: the `TASKS_DIR` env var, defaulting to `~/Dev/pipelinely/tasks`. The shell snippets below write it as `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}`. Set `TASKS_DIR` in your shell profile if you keep tasks elsewhere.

## Proactive reminder

When this skill is loaded: monitor this conversation going forward. Proactively suggest `/pipelinely-handover` before context degrades. Watch for: repeated re-reading of the same files, long tool output chains, user re-explaining context already covered.

## Steps

### 1. Find the task slug

Check the current working directory — worktrees live at `${WORKTREES_DIR:-$HOME/Dev/worktrees}/<slug>`. If not in a worktree, look for TASK.md in the current directory or parent. If still ambiguous, ask the user.

### 2. Determine session number

Count existing `HANDOVER-*.md` files in the task dir `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/`. `N = count + 1`.

### 3. Build the continuation prompt

Write a tight continuation context. Include only what is NOT derivable from TASK.md, git, or CLAUDE.md:

- Current phase and exactly where you stopped
- Decisions made verbally this session
- Constraints or gotchas discovered
- Known flakes / things NOT to "fix"
- Pending items in priority order with exact commands
- Any in-flight processes (CI, background tasks) and how to check them

Skeleton:
```
Handover #N for <task-slug> — continuing from previous session.

Read TASK.md for full context. Below is what's not in TASK.md:

## Where we stopped
<exact point — phase, file, line if relevant>

## Decisions made this session
- <decision>

## Pending (priority order)
1. <next action> — `<exact command>`

## Constraints
- <rules the next session must not violate>

## Watch-outs
- <surprising state, gotchas, broken assumptions>
```

Omit any section with nothing meaningful to say.

### 4. Write the handover file

Write the prompt to:
```
${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/HANDOVER-N.md
```

### 5. Update STATUS

```bash
echo "handover: session #N — continuing in new tab" > "${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/STATUS"
```

### 5.5. Snapshot session metrics (for Pipelinely cost tracking)

If `$COCKPIT_TASK_SLUG` is set in the environment and `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/METRICS` exists, copy it to a numbered snapshot before the tab closes:

```bash
SLUG=<task-slug>
TASK_DIR="${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/$SLUG"
# A session that already has its own METRICS-<session-id>.json needs no
# numbered snapshot — its numbers are already preserved under its own name,
# and snapshotting it too would count this session's tokens twice.
if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && [ -f "$TASK_DIR/METRICS-$CLAUDE_CODE_SESSION_ID.json" ]; then
  echo "Per-session metrics already recorded — skipping the numbered snapshot."
elif [ -f "$TASK_DIR/METRICS" ]; then
  # Count only the legacy digits-named snapshots: METRICS-<session-id>.json
  # files also match METRICS-*.json and would inflate N.
  SESSION_N=$(ls "$TASK_DIR"/METRICS-[0-9]*.json 2>/dev/null | grep -cE 'METRICS-[0-9]+\.json$' || true)
  NEXT=$((SESSION_N + 1))
  cp "$TASK_DIR/METRICS" "$TASK_DIR/METRICS-$NEXT.json"
fi
```

Replace `<task-slug>` with the actual slug from Step 1.

### 6. Open new iTerm2 tab (inside tmux)

The successor session runs inside its own named tmux session, exactly like a
freshly-dispatched worker (`orchestrator-prompt.md` step 4) — so closing its tab
detaches instead of killing it. It also **re-records both session files**, so the
dashboard follows the handover to the new tab instead of pointing at the old one.

#### 6a. Resolve the tasks dir once

```bash
echo "${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}"
```

Use that resolved absolute path as a literal everywhere below. `do shell script`
(`/bin/sh`, no profile), `write text` (interactive login zsh), and the launch
script (bash via shebang, no rc sourcing) are three different shells — a deferred
`${TASKS_DIR:-...}` can resolve differently in each and scatter the session files.

#### 6b. Write the launch script

Write `<resolved-tasks-dir>/<slug>/launch-handover-<N>.sh` with the **Write tool**
(literal bytes — no shell-escaping, unlike inlining the prompt into an AppleScript
string). A per-handover filename keeps the original dispatch `launch.sh` intact as
a record.

```bash
#!/bin/bash
cd "<resolved-tasks-dir>/<slug>"
export COCKPIT_TASK_SLUG=<slug>
exec claude "Read TASK.md then HANDOVER-<N>.md. BEFORE doing any task work: (1) rename this iTerm2 tab to '<slug>' using osascript; (2) cd to the worktree at \${WORKTREES_DIR:-\$HOME/Dev/worktrees}/<slug>; (3) continue the task from where the previous session left off."
```

The `\$` escaping keeps `${WORKTREES_DIR:-$HOME/Dev/worktrees}` unexpanded when
bash runs this script, so it reaches the claude prompt literally and expands later
in the *successor's* environment — not this session's.

#### 6c. Open the tab

The tmux session is `worker-<slug>-s<N>`, **not** `worker-<slug>`: the outgoing
session still holds that name right now, and attaching to it instead of starting
the successor would silently drop the new tab into the dying session's live
conversation.

```applescript
tell application "iTerm2"
  tell current window
    set newTab to (create tab with default profile)
    set sid to id of current session of newTab
    do shell script "echo " & sid & " > <resolved-tasks-dir>/<slug>/ITERM_SESSION"
    do shell script "echo worker-<slug>-s<N> > <resolved-tasks-dir>/<slug>/TMUX_SESSION"
    tell current session of newTab
      write text "tmux new-session -s worker-<slug>-s<N> \"bash '<resolved-tasks-dir>/<slug>/launch-handover-<N>.sh'\" || echo COCKPIT_TMUX_COLLISION"
    end tell
  end tell
end tell
```

No `-A`, even though `-s<N>` already makes a name collision unlikely: `-A` would
make tmux silently attach to whatever session already holds that exact name
instead of starting the successor — belt-and-suspenders with the `-s<N>` naming
scheme, same reasoning as the primary dispatch pattern in `orchestrator-prompt.md`.
A genuine collision now fails loudly (`COCKPIT_TMUX_COLLISION` printed into the
new, otherwise-empty tab) instead of silently misdirecting the handover.

Replace `<slug>`, `<N>`, and `<resolved-tasks-dir>` with the actual values before
running.

### 7. Confirm and stop

Print one line:
```
Handover #N written. New tab opening for <slug>.
```

Then stop. Do not continue working in this session.

Do **not** `tmux kill-session` this outgoing session on the way out, and do not
close its tab from here — the session files were already repointed at the
successor in step 6c, so just leaving is enough. Killing the session that this
very handover is running inside would take the process down mid-write.
