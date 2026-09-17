---
name: pipelinely
description: Activate the workflow orchestrator in the current session — loads working memory, adopts the orchestrator role, and shows the status board. Use to dispatch tasks to worker agents (new iTerm2 tabs), track progress, and manage worktrees/scratch dirs.
---

You are activating the workflow orchestrator. Do NOT open a new tab for yourself — operate as the orchestrator in the current session.

## Step 1 — Load the orchestrator prompt

Read `orchestrator-prompt.md` from the root of the cockpit-ai repo this skill ships in (`~/Dev/pipelinely/orchestrator-prompt.md` on the default checkout) in full. This is the source of truth for all orchestrator behavior.

## Step 2 — Load working memory (optional)

If a personal working-memory file exists (e.g. `~/Dev/my-context/CLAUDE.md` or a `CLAUDE.md` in the current project), read it for context. Skip if absent — the orchestrator prompt is self-sufficient.

## Step 3 — Register this session with the Cockpit dashboard

So the dashboard's backlog panel can paste a promoted item directly into this session (its "Start" button), capture this session's stable iTerm2 id and persist it to `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/ORCHESTRATOR_SESSION`.

**Guarded write — do not skip this check.** Every `/cockpit-<stage>` dashboard button stages its command into whatever session `ORCHESTRATOR_SESSION` currently points at, sitting unsent at the prompt until a human presses Enter. If this file gets silently overwritten to point at the wrong tab (e.g. `/pipelinely` was accidentally run inside a task's own worker tab), a dispatch meant for the real orchestrator lands in that unrelated tab instead and sits there as a dormant command — the developer can trigger it by accident just by typing normally and hitting Enter later, with no warning it was ever misdirected. (Confirmed root cause of a real incident: a stale `/pipelinely-qa` dispatch fired inside `marketing-landing-page`'s own worker tab, unrelated to what that session was doing.) Run this instead of a bare overwrite:

```bash
TASKS_DIR_RESOLVED="${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}"
mkdir -p "$TASKS_DIR_RESOLVED"
CURRENT_SID=$(osascript -e 'tell application "iTerm2" to id of current session of current window')

if [ -f "$TASKS_DIR_RESOLVED/ORCHESTRATOR_SESSION" ]; then
  OLD_SID=$(cat "$TASKS_DIR_RESOLVED/ORCHESTRATOR_SESSION")
  if [ "$OLD_SID" != "$CURRENT_SID" ]; then
    STILL_LIVE=$(osascript -e "
tell application \"iTerm2\"
  repeat with aWindow in windows
    tell aWindow
      repeat with aTab in tabs
        repeat with aSession in sessions of aTab
          if id of aSession is \"$OLD_SID\" then
            return \"live\"
          end if
        end repeat
      end repeat
    end tell
  end repeat
end tell
return \"dead\"")
    if [ "$STILL_LIVE" = "live" ]; then
      echo "ANOTHER ORCHESTRATOR SESSION IS ALREADY REGISTERED AND STILL OPEN ($OLD_SID) — do not overwrite automatically."
    fi
  fi
fi
```

If that script prints the "ANOTHER ORCHESTRATOR SESSION..." line, **stop and ask the developer** — with exactly two options: make this tab the orchestrator instead (proceed to the write below, replacing the old registration), or leave the existing one alone (don't register this tab; the developer probably meant to work in the existing orchestrator tab, not start a second one). Only proceed past this point without asking if the script printed nothing (no prior registration, or the prior one is confirmed dead — a closed/crashed tab, safe to replace).

Once clear to proceed, take the same `.orchestrator-pointer.lock` the Cockpit
dashboard server itself takes before touching either pointer file (see
`src/orchestratorLock.ts`) — this write is a second, independent writer of
`ORCHESTRATOR_SESSION`/`ORCHESTRATOR_TMUX` running in a completely different
process from the dashboard server, so only a lock file both sides honor can
actually make them mutually exclusive. Scoped to just this short write, not
the liveness check/developer-question above it — that step can pause for an
arbitrary amount of real time waiting on a human answer, and holding the lock
across that would block every dashboard dispatch for as long as the developer
takes to respond:

```bash
LOCK_PATH="$TASKS_DIR_RESOLVED/.orchestrator-pointer.lock"
DEADLINE=$((SECONDS + 15))
while ! (set -o noclobber; echo "{\"pid\":$$,\"acquiredAt\":$(($(date +%s) * 1000))}" > "$LOCK_PATH") 2>/dev/null; do
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_PATH" 2>/dev/null || date +%s) ))
  [ "$LOCK_AGE" -gt 30 ] && rm -f "$LOCK_PATH"  # stale — a crashed holder never released it
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "Could not acquire the orchestrator session lock — another operation is in progress; try again shortly."
    exit 1
  fi
  sleep 0.2
done

echo "$CURRENT_SID" > "$TASKS_DIR_RESOLVED/ORCHESTRATOR_SESSION"
[ -n "$TMUX" ] && tmux display-message -p '#S' > "$TASKS_DIR_RESOLVED/ORCHESTRATOR_TMUX"

rm -f "$LOCK_PATH"
```

The `ORCHESTRATOR_TMUX` line records the tmux session name (normally
`orchestrator`, from the `orch` alias) so the dashboard can reattach a
detached orchestrator instead of reporting it dead. It's guarded on `$TMUX`:
an orchestrator started outside tmux writes nothing and keeps today's
iTerm-id-only behavior.

## Step 4 — Start the Cockpit dashboard dev server

The dashboard (task board UI) lives at `http://localhost:3030/`. Start it if it isn't already running:

```bash
if lsof -i :3030 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "dashboard already running on :3030"
else
  cd ~/Dev/pipelinely && nohup npm run dev > /tmp/cockpit-dashboard.log 2>&1 &
  disown
  echo "dashboard starting on :3030 (log: /tmp/cockpit-dashboard.log)"
fi
```

Don't wait or poll for it to come up — just fire it and move on. Mention the URL when confirming ready.

## Step 5 — Confirm ready

Display the status board with all currently tracked tasks (read their STATUS files):

| # | Task | Status | Branch |
|---|------|--------|--------|
| — | (no active tasks) | — | — |

Announce: **Orchestrator ready.** Then wait for the user's first task.

From this point on, follow the rules and workflow defined in the orchestrator prompt exactly.
