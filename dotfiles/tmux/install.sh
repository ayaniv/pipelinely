#!/usr/bin/env bash
# dotfiles/tmux/install.sh — installs the packaged tmux.conf as ~/.tmux.conf,
# backing up any existing one first (same pattern as
# dotfiles/claude-statusline/install.sh).
# Usage: bash install.sh (run from anywhere, after cloning)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/install-helpers.sh
source "${SCRIPT_DIR}/../lib/install-helpers.sh"

require_command tmux "brew install tmux"

TARGET="$HOME/.tmux.conf"
backup_path "$TARGET" "${TARGET}.bak.$(date +%Y%m%d%H%M%S)"
cp "${SCRIPT_DIR}/tmux.conf" "$TARGET"

echo "Installed tmux.conf to $TARGET"
echo "Run 'tmux source-file $TARGET' to reload it in an existing session."
