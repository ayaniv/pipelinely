#!/usr/bin/env bash
# Installs the Claude Code statusline on a new machine.
# Usage: bash install.sh (run from anywhere, after cloning cockpit-ai)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

mkdir -p "$CLAUDE_DIR"
cp "$SCRIPT_DIR/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh"
chmod +x "$CLAUDE_DIR/statusline-command.sh"
echo "Copied statusline-command.sh to $CLAUDE_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found (required by the statusline script itself). Install it: brew install jq"
  exit 1
fi

if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
  jq -s '.[0] * .[1]' "$SETTINGS" "$SCRIPT_DIR/settings-snippet.json" > "$SETTINGS.tmp"
  mv "$SETTINGS.tmp" "$SETTINGS"
  echo "Merged statusLine into existing $SETTINGS (backup saved alongside it)"
else
  cp "$SCRIPT_DIR/settings-snippet.json" "$SETTINGS"
  echo "Created $SETTINGS with statusLine config"
fi

echo "Done. Restart Claude Code to see the statusline."
