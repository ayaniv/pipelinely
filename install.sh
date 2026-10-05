#!/usr/bin/env bash
# install.sh — one command to set up pipelinely: first checks every README
# prerequisite and stops, changing nothing, if any is missing; then clones the
# repo (skipped if already checked out, in which case it fast-forwards it),
# installs dependencies, symlinks the pipeline skills into ~/.claude/skills,
# and runs every optional dotfiles installer whose required binary is already
# on PATH. Safe to re-run — re-running is how an existing install picks up
# updates, and when it can't update, it says so at the end of its output.
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
INSTALLER_COMMAND='curl -fsSL https://pipelinely.cc/install.sh | sh'
LOCKFILE=package-lock.json
# The one local change the installer may discard: installers before npm ci
# ran `npm install`, which rewrote the tracked lockfile on every machine, so
# every existing checkout carries exactly this change.
INSTALLER_OWNED_CHANGE=" M $LOCKFILE"
BANNER_RULE='========================================================================'
HOMEBREW_INSTALL_COMMAND='/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

# Parallel arrays (bash 3.2 on macOS has no associative arrays): the Nth
# missing prerequisite and the fix that resolves it.
MISSING_ITEMS=()
MISSING_FIXES=()

# Why an existing checkout wasn't updated, git's own error text (if any) and
# the command that fixes it. Empty reason = not skipped.
UPDATE_SKIPPED_REASON=""
UPDATE_SKIPPED_DETAIL=""
UPDATE_FIX_COMMAND=""
# Claude Code reads skills only at session start, so any new commit or newly
# pointed skill link needs a restart to take effect.
NEEDS_CLAUDE_RESTART=false

# "<short sha> (<commit date>)" of the checkout's HEAD.
describe_commit() {
  echo "$(git -C "$DEST" rev-parse --short HEAD) ($(git -C "$DEST" log -1 --date=short --format=%cd))"
}

# Records why the update was skipped, for print_not_updated_banner to repeat
# after "Done". $1 = reason, $2 = git's error text (may be empty), $3 = the
# fix command.
skip_update() {
  UPDATE_SKIPPED_REASON="$1"
  UPDATE_SKIPPED_DETAIL="$2"
  UPDATE_FIX_COMMAND="$3"
  echo "NOT updating $DEST: $1 (details at the end)." >&2
}

# Fast-forwards an existing checkout so re-running the installer updates it.
# Never switches branches, never forces, and never discards anything but the
# lockfile change older installers made themselves. A skipped update must not
# abort the rest of the install, but it is never silent either.
update_existing_checkout() {
  local quoted_dest current_branch local_changes restore_output fetch_output merge_output old_head
  quoted_dest="$(printf '%q' "$DEST")"
  echo "Found existing checkout at $DEST — updating it..."
  if ! current_branch="$(git -C "$DEST" symbolic-ref -q --short HEAD)"; then
    skip_update "HEAD is detached (no branch is checked out)" "" "git -C $quoted_dest switch $UPDATE_BRANCH"
    return
  fi
  if [[ "$current_branch" != "$UPDATE_BRANCH" ]]; then
    skip_update "it is on branch '$current_branch', not '$UPDATE_BRANCH', and the installer never switches branches for you" "" "git -C $quoted_dest switch $UPDATE_BRANCH"
    return
  fi
  if ! git -C "$DEST" remote get-url origin >/dev/null 2>&1; then
    skip_update "it has no 'origin' remote to update from" "" "git -C $quoted_dest remote add origin $REMOTE"
    return
  fi
  # stderr stays out of the change list: a warning git prints while still
  # succeeding must not make a clean checkout look modified.
  if ! local_changes="$(git -C "$DEST" status --porcelain)"; then
    skip_update "git status failed (see git's error above)" "" "git -C $quoted_dest status"
    return
  fi
  if [[ "$local_changes" == "$INSTALLER_OWNED_CHANGE" ]]; then
    if ! restore_output="$(git -C "$DEST" checkout -- "$LOCKFILE" 2>&1)"; then
      skip_update "restoring $LOCKFILE failed" "$restore_output" "git -C $quoted_dest checkout -- $LOCKFILE"
      return
    fi
    echo "Restored $LOCKFILE (an earlier install rewrote it) before updating."
  elif [[ -n "$local_changes" ]]; then
    skip_update "it has local changes, which the installer never discards — commit them, or set them aside with the command below (bring them back later with git -C $quoted_dest stash pop)" "$local_changes" "git -C $quoted_dest stash push --include-untracked"
    return
  fi
  # No terminal prompt: a credential prompt would hang a piped `curl | sh`.
  if ! fetch_output="$(GIT_TERMINAL_PROMPT=0 git -C "$DEST" fetch origin "$UPDATE_BRANCH" 2>&1)"; then
    skip_update "fetching from origin failed (offline?), so nothing was changed" "$fetch_output" "git -C $quoted_dest fetch origin $UPDATE_BRANCH"
    return
  fi
  old_head="$(git -C "$DEST" rev-parse HEAD)"
  if ! merge_output="$(git -C "$DEST" merge --ff-only FETCH_HEAD 2>&1)"; then
    skip_update "local $UPDATE_BRANCH has diverged from origin and can't be fast-forwarded, and the installer never forces" "$merge_output" "git -C $quoted_dest pull --rebase origin $UPDATE_BRANCH"
    return
  fi
  if [[ "$(git -C "$DEST" rev-parse HEAD)" == "$old_head" ]]; then
    echo "Already up to date at $(describe_commit)."
  else
    NEEDS_CLAUDE_RESTART=true
    echo "Updated to $(describe_commit)."
  fi
}

# Repeats a skipped update after "Done", where it can't scroll away unread.
print_not_updated_banner() {
  [[ -n "$UPDATE_SKIPPED_REASON" ]] || return 0
  {
    echo
    echo "$BANNER_RULE"
    echo "pipelinely was NOT updated."
    echo "  Why: $UPDATE_SKIPPED_REASON."
    [[ -z "$UPDATE_SKIPPED_DETAIL" ]] || sed 's/^/      /' <<< "$UPDATE_SKIPPED_DETAIL"
    echo "  To fix it, run:"
    echo "    $UPDATE_FIX_COMMAND"
    echo "  then re-run: $INSTALLER_COMMAND"
    echo "  Until then, the installed skills still point at the OLD checkout: $DEST at $(describe_commit)."
    echo "$BANNER_RULE"
  } >&2
}

print_installed_version() {
  echo "Installed pipelinely:"
  echo "  checkout: $DEST"
  echo "  commit:   $(describe_commit)"
  echo "  version:  $(git -C "$DEST" describe --tags 2>/dev/null || echo untagged)"
}

# npm ci installs exactly the committed lockfile and never rewrites it, so the
# checkout stays clean and the next re-run can update it. If ci refuses (say,
# a lockfile out of sync with a locally edited package.json), npm install
# --no-save resolves the tree without writing the lockfile back either.
install_dependencies() {
  if npm --prefix "$DEST" ci --no-audit --no-fund; then
    return
  fi
  echo "npm ci failed (see above) — retrying with npm install --no-save." >&2
  if npm --prefix "$DEST" install --no-save --no-audit --no-fund; then
    return
  fi
  echo "install.sh: installing dependencies failed (see npm output above)." >&2
  print_not_updated_banner
  exit 1
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
  NEEDS_CLAUDE_RESTART=true
elif ! git -C "$DEST" rev-parse --git-dir >/dev/null 2>&1; then
  echo "install.sh: $DEST exists and is not a git repository" >&2
  exit 1
else
  update_existing_checkout
fi

# shellcheck source=dotfiles/lib/install-helpers.sh
source "$DEST/dotfiles/lib/install-helpers.sh"

echo "Installing dependencies..."
install_dependencies

echo "Linking pipeline skills into ~/.claude/skills..."
SKILLS_DIR="$HOME/.claude/skills"
BACKUP_DIR="$HOME/.claude/skills.bak"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
mkdir -p "$SKILLS_DIR"
for skill_source in "$DEST"/.claude/skills/*/; do
  skill_source="${skill_source%/}"
  name="$(basename "$skill_source")"
  target="$SKILLS_DIR/$name"
  if [[ -L "$target" && "$(readlink "$target")" == "$skill_source" ]]; then
    echo "  already linked $name"
    continue
  fi
  if [[ -e "$target" && ! -L "$target" ]]; then
    backup_path "$target" "$BACKUP_DIR/$name.$TIMESTAMP"
    echo "  backed up existing $name to ~/.claude/skills.bak/"
  fi
  ln -sfn "$skill_source" "$target"
  echo "  linked $name"
  NEEDS_CLAUDE_RESTART=true
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
if [[ "$NEEDS_CLAUDE_RESTART" == true ]]; then
  echo "Restart Claude Code so it loads the updated skills (it reads skills only at session start)."
fi
print_not_updated_banner
echo
print_installed_version
