#!/usr/bin/env bash
# The real-integration suite (e2e/integration/) takes over the developer's
# desktop for real: iTerm2 windows open and close, real keystrokes land,
# tmux sessions come and go. This is informed consent, not authentication —
# see tech-design-e2e-integration-confirm-gate.md's "What the gate is
# actually for". The mechanics here (TTY check, prompt, token) exist only to
# make a "yes" mean "yes, right now, this run", never "yes, some night last
# week".
set -euo pipefail

# Derived from this script's own location, never $PWD — the same file must
# work from the canonical checkout and from any worktree, the same way
# playwright.config.ts derives its own fixture paths from __dirname.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INTEGRATION_DIR="$REPO_ROOT/e2e/integration"

DRY_RUN=false
PASSTHROUGH_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=true
  else
    PASSTHROUGH_ARGS+=("$arg")
  fi
done

# A CI job, a cron, or a nested agent cannot be informed, so it cannot
# consent. This is the clause that stops the gate from being satisfiable by
# piping a `y` into stdin.
if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "test:e2e:integration: refusing — this must be run from an interactive terminal so a human can actually consent." >&2
  exit 1
fi

# Never a hand-maintained literal, so the warning cannot go stale as specs
# are added or removed under e2e/integration/.
SPEC_STEMS=()
for specFile in "$INTEGRATION_DIR"/*.spec.ts; do
  [ -e "$specFile" ] || continue
  stem="$(basename "$specFile" .spec.ts)"
  SPEC_STEMS+=("$stem")
done

echo "────────────────────────────────────────────────────────────────"
echo "  REAL-INTEGRATION E2E — THIS TAKES OVER YOUR DESKTOP"
echo "────────────────────────────────────────────────────────────────"
echo
echo "  ${#SPEC_STEMS[@]} spec files under e2e/integration/ are about to run:"
echo
for stem in "${SPEC_STEMS[@]}"; do
  echo "    $stem"
done
echo
echo "  While they run, on THIS Mac, for real:"
echo
echo "    • iTerm2 windows will open and close on their own, repeatedly"
echo "    • real keystrokes will be typed into them"
echo "    • tmux sessions will be created and killed"
echo "    • your foreground app may lose focus without warning"
echo
echo "  Don't type, and don't switch apps, until it finishes."
echo
echo "  Protected:  specs read/write only e2e/fixtures/tasks/ — your real"
echo "              ~/Dev/pipelinely/tasks/ORCHESTRATOR_SESSION is not a target"
echo "  NOT protected:  osascript reaches REAL iTerm2. A buggy spec can still"
echo "              land keystrokes in a window you care about."
echo
echo "  Ctrl-C now to abort."
echo
printf '  Run the real-integration suite? [y/N] '

# A bare `read` that hits EOF is a non-zero command under set -euo pipefail
# and would abort the script with no message at all — that would read as a
# crash rather than a refusal.
read -r answer || answer=""

if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
  echo "aborted: consent not given" >&2
  exit 1
fi

NONCE="$(openssl rand -hex 16)"
ISSUED_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
TOKEN_PATH="${TMPDIR:-/tmp}/cockpit-e2e-consent-$$.json"

cat > "$TOKEN_PATH" <<EOF
{"nonce":"$NONCE","issuedAt":$ISSUED_AT_MS,"runnerPid":$$}
EOF

# The token dies with the shell that minted it.
trap 'rm -f "$TOKEN_PATH"' EXIT INT TERM

export COCKPIT_E2E_CONSENT="$NONCE"
export COCKPIT_E2E_CONSENT_FILE="$TOKEN_PATH"
export TASKS_DIR="$REPO_ROOT/e2e/fixtures/tasks"

if [ "$DRY_RUN" = true ]; then
  # Case 4 needs this path to assert the trap cleaned it up. A real run has
  # no reason to put a machine-readable line in front of a human.
  echo "CONSENT_TOKEN=$TOKEN_PATH"
  cd "$REPO_ROOT"
  npx tsx scripts/e2e-integration/verify-consent.ts
else
  cd "$REPO_ROOT"
  # macOS's stock /bin/bash is 3.2.57, where expanding an *empty* array with
  # [@] under `set -u` throws "unbound variable" rather than expanding to
  # nothing — the no-extra-args path (the primary, documented usage) would
  # crash here instead of ever reaching Playwright. The `+` alternate-value
  # form sidesteps that: it substitutes nothing when the array is empty,
  # the real expansion otherwise.
  npx playwright test --project=integration "${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}"
fi
