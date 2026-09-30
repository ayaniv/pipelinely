#!/usr/bin/env bash
# install.sh — one command to set up pipelinely: first checks every README
# prerequisite and stops, changing nothing, if any is missing; then clones the
# repo (skipped if already checked out, in which case it fast-forwards it),
# installs dependencies, symlinks the pipeline skills into ~/.claude/skills,
# and runs every optional dotfiles installer whose required binary is already
# on PATH. Safe to re-run — re-running is how an existing install picks up
# updates.
# Usage: curl -fsSL https://pipelinely.cc/install.sh | sh
#    or: bash install.sh   (from an existing clone)
# Overrides (all optional): PIPELINELY_DIR, PIPELINELY_REMOTE, and — so tests
# never depend on the developer's own machine — PIPELINELY_APP_DIRS (where to
# look for iTerm.app) and PIPELINELY_BREW_PREFIXES (where to look for a
# Homebrew install that isn't on PATH yet) — both colon-separated lists, so a
# path with a space in it survives — and PIPELINELY_GH_TIMEOUT_SECONDS (how
# long to wait on `gh auth status`, which talks to the network).
set -euo pipefail

DEST="${PIPELINELY_DIR:-$HOME/Dev/pipelinely}"
# HTTPS, not SSH: a first-time `curl | sh` user usually has no GitHub SSH key.
REMOTE="${PIPELINELY_REMOTE:-https://github.com/ayaniv/pipelinely.git}"
UPDATE_BRANCH=main
MIN_NODE_MAJOR=20
DEFAULT_GH_AUTH_TIMEOUT_SECONDS=10
GH_AUTH_TIMEOUT_SECONDS="${PIPELINELY_GH_TIMEOUT_SECONDS:-$DEFAULT_GH_AUTH_TIMEOUT_SECONDS}"
# Anything but a positive integer (non-numeric, or 0) would make the watchdog
# kill gh at once, falsely reporting it as not signed in.
[[ "$GH_AUTH_TIMEOUT_SECONDS" =~ ^0*[1-9][0-9]*$ ]] || GH_AUTH_TIMEOUT_SECONDS="$DEFAULT_GH_AUTH_TIMEOUT_SECONDS"
# Colon-separated, not space-separated: the default embeds $HOME, which may
# itself contain a space (/Users/Jane Doe).
IFS=: read -r -a APP_DIRS <<< "${PIPELINELY_APP_DIRS:-/Applications:$HOME/Applications}"
IFS=: read -r -a BREW_PREFIXES <<< "${PIPELINELY_BREW_PREFIXES:-/opt/homebrew:/usr/local}"
HOMEBREW_INSTALL_COMMAND='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

# Parallel arrays (bash 3.2 on macOS has no associative arrays): the Nth
# missing prerequisite and the fix that resolves it.
MISSING_ITEMS=()
MISSING_FIXES=()

# Fast-forwards an existing checkout so re-running the installer updates it.
# Never touches a checkout with local changes or on another branch, and
# --ff-only refuses rather than merges on divergence — a failed or skipped
# update must not abort the rest of the install.
update_existing_checkout() {
  local current_branch
  current_branch="$(git -C "$DEST" symbolic-ref -q --short HEAD || true)"
  if [[ "$current_branch" != "$UPDATE_BRANCH" ]]; then
    echo "Found existing checkout at $DEST — skipping update (not on ${UPDATE_BRANCH})."
  elif [[ -n "$(git -C "$DEST" status --porcelain)" ]]; then
    echo "Found existing checkout at $DEST — skipping update (local changes)."
  elif git -C "$DEST" pull --ff-only; then
    echo "Updated existing checkout at $DEST."
  else
    echo "Found existing checkout at $DEST — update failed (see above); continuing with what's there." >&2
  fi
}

record_ok() {
  echo "  ok  $1"
}

record_missing() {
  MISSING_ITEMS+=("$1")
  MISSING_FIXES+=("$2")
}

# Records one prerequisite as ok or missing based on whether `command -v`
# finds its binary. $1 = label, $2 = binary, $3 = fix when missing.
check_command() {
  if command -v "$2" >/dev/null 2>&1; then
    record_ok "$1"
  else
    record_missing "$1 not found" "$3"
  fi
}

iterm_installed() {
  local app_dir
  for app_dir in "${APP_DIRS[@]}"; do
    [[ -d "$app_dir/iTerm.app" ]] && return 0
  done
  return 1
}

# `command -v git` is true on a fresh Mac with no Command Line Tools, because
# /usr/bin/git is a shim that only then offers to install them — so actually
# run it.
check_git() {
  if git --version >/dev/null 2>&1; then
    record_ok "git"
  else
    record_missing "git not found (or Xcode Command Line Tools not installed)" "xcode-select --install"
  fi
}

# Runs a command, killing it after $1 seconds. macOS ships no `timeout`.
# The watchdog's output is detached so a lingering `sleep` can't hold a
# caller's pipe open. Returns the command's status (143 when it timed out).
run_with_timeout() {
  local seconds="$1" command_pid watchdog_pid command_status=0
  shift
  "$@" >/dev/null 2>&1 &
  command_pid=$!
  # The watchdog traps TERM so stopping it exits normally (no "Terminated" job
  # report on stderr) and takes its own `sleep` with it instead of orphaning it.
  (
    local sleep_pid=""
    # Installed before the sleep starts so an instant-exit command can't send
    # TERM before it exists and leave the sleep orphaned.
    trap '[[ -z "$sleep_pid" ]] || kill "$sleep_pid" 2>/dev/null; exit 0' TERM
    sleep "$seconds" &
    sleep_pid=$!
    wait "$sleep_pid" && kill "$command_pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  watchdog_pid=$!
  wait "$command_pid" 2>/dev/null || command_status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$command_status"
}

# Scoped to github.com so a stale token for some other configured host can't
# fail it. It needs the network, hence the bound; a timeout or offline run is
# reported as such rather than as a plain "not signed in".
check_gh_auth() {
  local auth_status=0
  run_with_timeout "$GH_AUTH_TIMEOUT_SECONDS" gh auth status --hostname github.com || auth_status=$?
  if (( auth_status == 0 )); then
    record_ok "gh signed in"
  else
    record_missing "gh not signed in to github.com (or the check failed offline / timed out)" "gh auth login"
  fi
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    record_missing "node not found (need ${MIN_NODE_MAJOR}+)" "brew install node"
    return
  fi
  local node_version node_major
  node_version="$(node --version 2>/dev/null || true)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= MIN_NODE_MAJOR )); then
    record_ok "node $node_version"
  else
    record_missing "node ${MIN_NODE_MAJOR}+ required (found ${node_version:-an unreadable version})" "brew install node"
  fi
}

# The Homebrew line comes first in the MISSING block because it's a
# precondition for every `brew install` fix. Prints nothing when brew is on
# PATH or no fix needs it.
print_homebrew_advice() {
  local needs_brew=false fix prefix profile
  for fix in ${MISSING_FIXES[@]+"${MISSING_FIXES[@]}"}; do
    [[ "$fix" == brew* ]] && needs_brew=true
  done
  if [[ "$needs_brew" == false ]] || command -v brew >/dev/null 2>&1; then
    return
  fi
  for prefix in "${BREW_PREFIXES[@]}"; do
    if [[ -x "$prefix/bin/brew" ]]; then
      case "${SHELL:-}" in
        */zsh) profile="~/.zprofile" ;;
        */bash) profile="~/.bash_profile" ;;
        *) profile="~/.profile" ;;
      esac
      echo "  Homebrew is installed but not on your PATH. Add it permanently, then reload:" >&2
      echo "      echo 'eval \"\$($prefix/bin/brew shellenv)\"' >> $profile" >&2
      echo "      eval \"\$($prefix/bin/brew shellenv)\"" >&2
      return
    fi
  done
  echo "  Homebrew isn't installed. Install it first:" >&2
  echo "      $HOMEBREW_INSTALL_COMMAND" >&2
}

# Checks every README prerequisite, collecting the gaps instead of exiting at
# the first one, so a new user fixes everything in a single pass. Runs before
# anything is cloned, installed or linked. dotfiles/lib/install-helpers.sh's
# own require_command isn't reachable yet — it arrives with the clone below.
preflight() {
  echo "Checking prerequisites..."

  # Everything below assumes macOS (brew fixes, iTerm2), so a positively
  # identified other OS bails out early rather than print advice that's wrong
  # there. An unresolvable uname (empty PATH) just counts as a missing item.
  local os_name
  os_name="$(uname -s 2>/dev/null || true)"
  if [[ "$os_name" == "Darwin" ]]; then
    record_ok "macOS"
  elif [[ -n "$os_name" ]]; then
    echo "MISSING: macOS — Pipelinely only runs on macOS (found $os_name)." >&2
    exit 1
  else
    record_missing "macOS required (could not run uname)" "(Pipelinely only runs on macOS)"
  fi
  if iterm_installed; then
    record_ok "iTerm2"
  else
    record_missing "iTerm2 not found" "brew install --cask iterm2"
  fi
  check_git
  check_node
  check_command "npm" npm "brew install node"
  check_command "tmux" tmux "brew install tmux"
  check_command "jq" jq "brew install jq"
  check_command "gh" gh "brew install gh"
  if command -v gh >/dev/null 2>&1; then
    check_gh_auth
  fi
  check_command "claude" claude "npm install -g @anthropic-ai/claude-code"

  if (( ${#MISSING_ITEMS[@]} == 0 )); then
    return
  fi
  {
    echo
    echo "MISSING prerequisites — install these, then re-run this script:"
  } >&2
  print_homebrew_advice
  local index
  for index in "${!MISSING_ITEMS[@]}"; do
    echo "  - ${MISSING_ITEMS[$index]}  →  ${MISSING_FIXES[$index]}" >&2
  done
  exit 1
}

preflight

if [[ ! -e "$DEST" ]]; then
  echo "Cloning pipelinely into $DEST..."
  git clone "$REMOTE" "$DEST"
elif ! git -C "$DEST" rev-parse --git-dir >/dev/null 2>&1; then
  echo "install.sh: $DEST exists and is not a git repository" >&2
  exit 1
else
  update_existing_checkout
fi

# shellcheck source=dotfiles/lib/install-helpers.sh
source "$DEST/dotfiles/lib/install-helpers.sh"

echo "Installing dependencies..."
npm --prefix "$DEST" install

echo "Linking pipeline skills into ~/.claude/skills..."
SKILLS_DIR="$HOME/.claude/skills"
BACKUP_DIR="$HOME/.claude/skills.bak"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
mkdir -p "$SKILLS_DIR"
for skill_source in "$DEST"/.claude/skills/*/; do
  skill_source="${skill_source%/}"
  name="$(basename "$skill_source")"
  target="$SKILLS_DIR/$name"
  if [[ -e "$target" && ! -L "$target" ]]; then
    backup_path "$target" "$BACKUP_DIR/$name.$TIMESTAMP"
    echo "  backed up existing $name to ~/.claude/skills.bak/"
  fi
  ln -sfn "$skill_source" "$target"
  echo "  linked $name"
done

echo "Running optional dotfiles installers (each skips itself if its required binary isn't on PATH)..."
for installer in "$DEST"/dotfiles/*/install.sh; do
  name="$(basename "$(dirname "$installer")")"
  if bash "$installer"; then
    :
  else
    echo "  skipped $name — see message above"
  fi
done

echo
echo "Done. Next steps:"
echo "  cd $DEST && npm start"
echo "  then run /pipelinely in a dedicated Claude Code tab"
