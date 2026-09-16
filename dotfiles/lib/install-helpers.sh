#!/usr/bin/env bash
# dotfiles/lib/install-helpers.sh — shared functions for the dotfiles
# installers (dotfiles/tmux/install.sh, dotfiles/plannotator/install.sh).
# Sourced, not executed.

# require_command <cmd> <install-hint>
# Prints "<cmd> not found on PATH — install it first: <hint>" to stderr and
# returns non-zero when <cmd> isn't resolvable. Callers run this before
# writing anything, under `set -e`, so a missing prerequisite aborts the
# installer immediately and leaves nothing behind.
require_command() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "${cmd} not found on PATH — install it first: ${hint}" >&2
    return 1
  fi
}

# backup_path <path> <backup_target>
# Moves an existing file or directory at <path> to <backup_target>,
# creating <backup_target>'s parent directory first. A no-op if <path>
# doesn't exist, so callers can call it unconditionally.
backup_path() {
  local source="$1"
  local backup_target="$2"
  [ -e "$source" ] || return 0
  mkdir -p "$(dirname "$backup_target")"
  mv "$source" "$backup_target"
}
