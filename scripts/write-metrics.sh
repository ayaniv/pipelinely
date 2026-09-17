#!/usr/bin/env bash
# Snapshot this Claude Code session's token usage into the task's METRICS file
# so the Pipelinely dashboard's CTX/MODEL/TOKENS/COST tiles stay live.
#
# Usage: scripts/write-metrics.sh [slug]
#   slug defaults to $COCKPIT_TASK_SLUG (set by the orchestrator when it
#   launches a worker tab).
#
# Usage: scripts/write-metrics.sh --orchestrator
#   (or COCKPIT_ROLE=orchestrator scripts/write-metrics.sh) — the
#   orchestrator's own session is not a task, so this writes
#   <TASKS_DIR>/ORCHESTRATOR_METRICS instead of a per-task METRICS file. Same
#   JSON, same write-metrics.py producer — one writer, not two.
set -euo pipefail

IS_ORCHESTRATOR=false
SLUG_ARG=""
for arg in "$@"; do
  if [ "$arg" = "--orchestrator" ]; then
    IS_ORCHESTRATOR=true
  else
    SLUG_ARG="$arg"
  fi
done
if [ "${COCKPIT_ROLE:-}" = "orchestrator" ]; then
  IS_ORCHESTRATOR=true
fi

PROJECT_SLUG=$(pwd | sed 's/\//-/g')
TRANSCRIPT="$HOME/.claude/projects/${PROJECT_SLUG}/${CLAUDE_CODE_SESSION_ID:?CLAUDE_CODE_SESSION_ID not set}.jsonl"

if [ ! -f "$TRANSCRIPT" ]; then
  echo "write-metrics.sh: transcript not found at $TRANSCRIPT" >&2
  exit 1
fi

STAGE="${COCKPIT_STAGE:-}"
METRICS_JSON=$(python3 "$(dirname "$0")/write-metrics.py" "$TRANSCRIPT" "$CLAUDE_CODE_SESSION_ID" "$STAGE")

if [ "$IS_ORCHESTRATOR" = true ]; then
  ORCHESTRATOR_METRICS_PATH="${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/ORCHESTRATOR_METRICS"
  # Via a temp file so the dashboard's watcher never reads a half-written
  # JSON document — same precedent as the per-session file below.
  printf '%s\n' "$METRICS_JSON" > "$ORCHESTRATOR_METRICS_PATH.tmp" && mv "$ORCHESTRATOR_METRICS_PATH.tmp" "$ORCHESTRATOR_METRICS_PATH"
  exit 0
fi

SLUG="${SLUG_ARG:-${COCKPIT_TASK_SLUG:-}}"
if [ -z "$SLUG" ]; then
  echo "write-metrics.sh: no task slug — pass one as \$1 or set COCKPIT_TASK_SLUG" >&2
  exit 1
fi

TASK_DIR="${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/$SLUG"

# The legacy single-file snapshot. Still written: /pipelinely-handover, the statusline
# and every task dir that predates per-session files all depend on it.
printf '%s\n' "$METRICS_JSON" > "$TASK_DIR/METRICS"

# One file per Claude session, so a QA session no longer clobbers the dev
# session that ran before it in the same task dir. Written via a temp file so
# the dashboard's watcher never reads a half-written JSON document.
SESSION_FILE="$TASK_DIR/METRICS-$CLAUDE_CODE_SESSION_ID.json"
printf '%s\n' "$METRICS_JSON" > "$SESSION_FILE.tmp" && mv "$SESSION_FILE.tmp" "$SESSION_FILE"
