#!/usr/bin/env bash
# Open a worker tab for a task: collision check → STATUS=working → iTerm2 tab
# running the task's launch script in a fresh tmux session → (optionally)
# claim ITERM_SESSION/TMUX_SESSION. This is orchestrator-prompt.md step 4's
# shared "Reusable form" as one command, because run by hand as separate tool
# calls the STATUS write kept getting dropped — leaving a stale `waiting: ...`
# the dashboard reads as needs-you while the new session is actually working.
#
# Usage:
#   scripts/dispatch-tab.sh \
#     --tasks-dir <absolute resolved tasks dir> \
#     --slug <task-slug> \
#     --tmux-name <worker-<slug> | worker-<slug>-<suffix>> \
#     --launch-script <absolute path to launch.sh / launch-<suffix>.sh> \
#     --claim-pointers yes|no
#
# Exit codes: 0 tab opened and this dispatch's command confirmed started in it ·
# 1 runtime failure (including a tab whose command never started, or whose
#   tmux name was taken by another session after the collision check) ·
# 2 bad arguments ·
# 3 COLLISION (a tmux session already owns --tmux-name; nothing was changed).
set -euo pipefail

readonly EXIT_RUNTIME=1
readonly EXIT_BAD_ARGS=2
readonly EXIT_COLLISION=3

fail() {
  local exit_code="$1"
  shift
  echo "dispatch-tab: $*" >&2
  exit "$exit_code"
}

usage_fail() {
  fail "$EXIT_BAD_ARGS" "$* (usage: dispatch-tab.sh --tasks-dir <abs> --slug <slug> --tmux-name <name> --launch-script <abs> --claim-pointers yes|no)"
}

TASKS_DIR_ARG=""
SLUG=""
TMUX_NAME=""
LAUNCH_SCRIPT=""
CLAIM_POINTERS=""

while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage_fail "missing value for $1"
  case "$1" in
    --tasks-dir) TASKS_DIR_ARG="$2" ;;
    --slug) SLUG="$2" ;;
    --tmux-name) TMUX_NAME="$2" ;;
    --launch-script) LAUNCH_SCRIPT="$2" ;;
    --claim-pointers) CLAIM_POINTERS="$2" ;;
    *) usage_fail "unknown argument: $1" ;;
  esac
  shift 2
done

for required in TASKS_DIR_ARG SLUG TMUX_NAME LAUNCH_SCRIPT CLAIM_POINTERS; do
  [[ -n "${!required}" ]] || usage_fail "missing required flag for ${required}"
done

# These values end up inside shell- and AppleScript-quoted strings in a tab
# nobody is watching; refuse the characters that could break that quoting
# rather than trying to escape them.
for value in "$TASKS_DIR_ARG" "$SLUG" "$TMUX_NAME" "$LAUNCH_SCRIPT"; do
  [[ "$value" != *[\"\'\\]* ]] || usage_fail "value must not contain quotes or backslashes: $value"
done

[[ "$CLAIM_POINTERS" == "yes" || "$CLAIM_POINTERS" == "no" ]] \
  || usage_fail "--claim-pointers must be yes or no, got: $CLAIM_POINTERS"
[[ "$TASKS_DIR_ARG" == /* ]] || usage_fail "--tasks-dir must be an absolute path, got: $TASKS_DIR_ARG"
[[ "$LAUNCH_SCRIPT" == /* ]] || usage_fail "--launch-script must be an absolute path, got: $LAUNCH_SCRIPT"

TASK_DIR="${TASKS_DIR_ARG%/}/${SLUG}"
[[ -d "$TASK_DIR" ]] || usage_fail "task dir does not exist: $TASK_DIR"
[[ -f "$LAUNCH_SCRIPT" ]] || usage_fail "launch script does not exist: $LAUNCH_SCRIPT"

command -v tmux >/dev/null || fail "$EXIT_RUNTIME" "tmux not found on PATH"

# `=` forces an exact name match so a longer slug that merely starts with this
# one isn't mistaken for a collision; quoted so zsh can't `=`-expand it if this
# line is ever copied into an interactive shell.
if tmux has-session -t "=${TMUX_NAME}" 2>/dev/null; then
  # Never kill it here: a live session is a running Claude process holding
  # real context. Reattach-vs-kill is the developer's call, made outside this script.
  fail "$EXIT_COLLISION" "COLLISION: tmux session '${TMUX_NAME}' already exists — not dispatching; ask the developer whether to reattach or kill it"
fi

STATUS_PATH="${TASK_DIR}/STATUS"
STATUS_BACKUP=""
if [[ -f "$STATUS_PATH" ]]; then
  STATUS_BACKUP="$(mktemp)"
  cp "$STATUS_PATH" "$STATUS_BACKUP"
fi
# Proof that *this* dispatch's command ran: the typed tmux command touches it
# before exec'ing the launch script. Unlike asking tmux whether a session by
# that name exists, a session some other dispatch started can't create it, and
# a launch script that exits instantly still leaves it behind.
ACK_DIR="$(mktemp -d)"
ACK_PATH="${ACK_DIR}/started"
trap '[[ -z "$STATUS_BACKUP" ]] || rm -f "$STATUS_BACKUP"; rm -rf "$ACK_DIR"' EXIT

restore_status() {
  if [[ -n "$STATUS_BACKUP" ]]; then
    cp "$STATUS_BACKUP" "$STATUS_PATH"
  else
    rm -f "$STATUS_PATH"
  fi
}

echo "working" > "$STATUS_PATH"

# Values arrive as argv and are only ever used through `quoted form of`, never
# spliced into the AppleScript source. No `-A` on new-session: a same-name
# session racing this dispatch must fail loudly (COCKPIT_TMUX_COLLISION in the
# new tab), not silently attach this tab to someone else's conversation.
if ! ITERM_SESSION_ID="$(osascript - "$TMUX_NAME" "$LAUNCH_SCRIPT" "$ACK_PATH" <<'APPLESCRIPT'
on run argv
  set tmuxName to item 1 of argv
  set launchScript to item 2 of argv
  set ackPath to item 3 of argv
  set sessionCommand to "touch " & quoted form of ackPath & " && exec bash " & quoted form of launchScript
  set tmuxCommand to "tmux new-session -s " & quoted form of tmuxName & " " & quoted form of sessionCommand & " || echo COCKPIT_TMUX_COLLISION"
  tell application "iTerm2"
    tell current window
      set newTab to (create tab with default profile)
      set sid to id of current session of newTab
      tell current session of newTab
        write text tmuxCommand
      end tell
    end tell
  end tell
  return sid
end run
APPLESCRIPT
)"; then
  # A `working` card with no tab behind it is the same lie this script exists
  # to prevent, just inverted — put back whatever STATUS said before.
  restore_status
  fail "$EXIT_RUNTIME" "osascript failed to open the tab for ${SLUG}; STATUS restored"
fi

# osascript succeeding only proves the tab exists and `write text` was sent —
# not that the typed command arrived intact (a stray keystroke landing in the
# fresh tab first turned `tmux` into `atmux` in QA), nor that the name was
# still free by then. Wait for this dispatch's ack before declaring success.
SESSION_TIMEOUT_SECONDS="${DISPATCH_TAB_SESSION_TIMEOUT_SECONDS:-10}"
SESSION_POLL_INTERVAL_SECONDS=0.2
session_deadline=$((SECONDS + SESSION_TIMEOUT_SECONDS))
until [[ -e "$ACK_PATH" ]]; do
  if (( SECONDS >= session_deadline )); then
    restore_status
    if tmux has-session -t "=${TMUX_NAME}" 2>/dev/null; then
      fail "$EXIT_RUNTIME" "COLLISION: another tmux session took '${TMUX_NAME}' after the collision check, so tab ${ITERM_SESSION_ID} did not start this dispatch's launch script; STATUS restored, pointers not claimed — ask the developer whether to reattach or kill it"
    fi
    fail "$EXIT_RUNTIME" "tab ${ITERM_SESSION_ID} opened but tmux session '${TMUX_NAME}' never started within ${SESSION_TIMEOUT_SECONDS}s (the typed command likely arrived corrupted — check that tab); STATUS restored, pointers not claimed"
  fi
  sleep "$SESSION_POLL_INTERVAL_SECONDS"
done

if [[ "$CLAIM_POINTERS" == "yes" ]]; then
  echo "$ITERM_SESSION_ID" > "${TASK_DIR}/ITERM_SESSION"
  echo "$TMUX_NAME" > "${TASK_DIR}/TMUX_SESSION"
fi

echo "dispatch-tab: opened ${TMUX_NAME} for ${SLUG} (iTerm session ${ITERM_SESSION_ID}, pointers claimed: ${CLAIM_POINTERS})"
