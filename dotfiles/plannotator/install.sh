#!/usr/bin/env bash
# dotfiles/plannotator/install.sh — vendors the 3 plannotator skills into
# ~/.claude/skills. A differing existing skill is backed up to
# ~/.claude/skills.bak/ rather than inside ~/.claude/skills/, since a backup
# left there would be discovered as a second skill with the same name.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/install-helpers.sh
source "${SCRIPT_DIR}/../lib/install-helpers.sh"

require_command plannotator "see https://github.com/anthropics/plannotator for install instructions"

SKILLS_DIR="$HOME/.claude/skills"
BACKUP_DIR="$HOME/.claude/skills.bak"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"

mkdir -p "$SKILLS_DIR"

for skill_source in "${SCRIPT_DIR}"/skills/*/; do
  name="$(basename "$skill_source")"
  skill_source="${skill_source%/}"
  target="${SKILLS_DIR}/${name}"

  if [ -d "$target" ] && ! diff -rq "$skill_source" "$target" >/dev/null 2>&1; then
    backup_path "$target" "${BACKUP_DIR}/${name}.${TIMESTAMP}"
  fi
  rm -rf "$target"
  cp -R "$skill_source" "$target"
  echo "Installed ${name} to $target"
done
