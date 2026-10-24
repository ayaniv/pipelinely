---
name: pipelinely
description: Idempotent entry point — turns this tab into the orchestrator on every run. Onboarding a repo is offered lazily, the first time a task targets it. Invoke as `/pipelinely`.
allowed-tools: ["Bash", "Read", "Write", "AskUserQuestion"]
---

# Pipelinely

## Orchestrator mode

You are activating the workflow orchestrator. Do NOT open a new tab for yourself — operate as the orchestrator in the current session. Onboarding a project is not a step here: `orchestrator-prompt.md`'s **Onboarding offer** runs the first time a dispatch targets a repo.

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
[ -z "$TMUX" ] && echo "WARNING: this orchestrator is not inside tmux — the dashboard's dispatch buttons type through tmux only and will refuse to write here. Restart it with the \`orch\` alias."

rm -f "$LOCK_PATH"
```

The `ORCHESTRATOR_TMUX` line records the tmux session name (normally
`orchestrator`, from the `orch` alias) so the dashboard can reattach a
detached orchestrator instead of reporting it dead, and is where every
dashboard dispatch button types (through tmux, never through iTerm2
keystrokes). It's guarded on `$TMUX`: an orchestrator started outside tmux
writes nothing, prints the warning above, and the dispatch buttons refuse
(503) until it is restarted inside tmux.

## Step 4 — Start the Cockpit dashboard dev server

The dashboard (task board UI) lives at `http://localhost:3030/`. Start it if it isn't already running:

```bash
if lsof -i :3030 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "dashboard already running on :3030"
else
  cd ~/Dev/pipelinely && env -u COCKPIT_AUTO_OPEN_BROWSER nohup npm run dev > /tmp/cockpit-dashboard.log 2>&1 &
  disown
  echo "dashboard starting on :3030 (log: /tmp/cockpit-dashboard.log)"
fi
```

Fire it and move on to the next step, which waits for it to answer. `env -u COCKPIT_AUTO_OPEN_BROWSER` is deliberate: if that variable leaked into this shell, the server would open a browser at boot, before the user has been asked anything.

## Step 5 — Introduce the dashboard

Never open a browser without the user's consent: the server only auto-opens one when `COCKPIT_AUTO_OPEN_BROWSER` is set, and Step 4 launches it with that variable unset. The only `open` command in this skill is the one below, run on an explicit answer.

Resolve the marker path once: `INTRO_MARKER="${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/DASHBOARD_INTRO_SEEN"`.

1. **Wait until the dashboard answers**, a bounded poll of about 30 seconds (each try capped at 2 seconds by `--max-time`, one per second, never a longer foreground sleep):

   ```bash
   for _ in $(seq 1 30); do
     curl -sf --max-time 2 -o /dev/null http://localhost:3030/ && break
     sleep 1
   done
   curl -sf --max-time 2 -o /dev/null http://localhost:3030/ && echo "dashboard is up" || echo "dashboard did not come up"
   ```

   If it never came up, say so, print the log path (`/tmp/cockpit-dashboard.log`), skip the rest of this step and go to Step 6: never open a browser at a dead URL, and do not write the marker.

2. **Already introduced?** If `$INTRO_MARKER` exists, skip the explanation and the question but still print the URL (`Dashboard: http://localhost:3030`), then go to Step 6.

3. **Explain what the dashboard is**, in two or three plain sentences: it is the board of their tasks and agent tabs at http://localhost:3030, where they see what each task is doing, what needs them, and press the next-stage buttons; it runs only on their machine. Add that pressing Enter opens it in their browser, and the other option leaves the browser closed.

4. **Ask for consent** with the `AskUserQuestion` tool: one question, two options, in this order so that pressing Enter picks the first:
   - `Open the dashboard in my browser (Recommended)`
   - `Not now, I'll open it myself`

   Run `open http://localhost:3030` (macOS) only on the first option. On "Not now" or any other answer, open nothing. Print the URL either way. If `AskUserQuestion` is unavailable here, print the URL and the sentence "open it when you are ready" and open nothing.

5. **Remember it** (the `DASHBOARD_INTRO_SEEN` file) only after the question was answered: `touch "$INTRO_MARKER" 2>/dev/null || echo "could not write $INTRO_MARKER, the introduction will be shown again"`. A missing or unwritable marker only means the introduction is shown again next time, never an error. Do not write it when the question was never asked, or when it was dismissed or rejected (Esc, tool denied): a dismissed question counts as unanswered, so open nothing and write no marker.

## Step 6 — Confirm ready

Display the status board with all currently tracked tasks (read their STATUS files):

| # | Task | Status | Branch |
|---|------|--------|--------|
| — | (no active tasks) | — | — |

Announce: **Orchestrator ready.** Then wait for the user's first task.

From this point on, follow the rules and workflow defined in the orchestrator prompt exactly.
