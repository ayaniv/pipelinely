#!/usr/bin/env bash
# install.sh — one command to set up pipelinely: clones the repo (skipped if
# already checked out), installs dependencies, symlinks the pipeline skills
# into ~/.claude/skills, and runs every optional dotfiles installer whose
# required binary is already on PATH. Safe to re-run.
# Usage: curl -fsSL https://pipelinely.cc/install.sh | sh
#    or: bash install.sh   (from an existing clone)
set -euo pipefail

DEST="${PIPELINELY_DIR:-$HOME/Dev/pipelinely}"
REMOTE="${PIPELINELY_REMOTE:-git@github.com:ayaniv/pipelinely.git}"

# git/node/npm are checked inline — dotfiles/lib/install-helpers.sh's own
# require_command isn't reachable yet until the clone below exists.
for cmd in git node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "${cmd} not found on PATH — install it first, then re-run this script." >&2
    exit 1
  fi
done

if [[ ! -e "$DEST" ]]; then
  echo "Cloning pipelinely into $DEST..."
  git clone "$REMOTE" "$DEST"
elif ! git -C "$DEST" rev-parse --git-dir >/dev/null 2>&1; then
  echo "install.sh: $DEST exists and is not a git repository" >&2
  exit 1
else
  echo "Found existing checkout at $DEST — skipping clone."
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
echo "  then run /run-orchestrator in a dedicated Claude Code tab"
