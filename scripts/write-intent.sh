#!/usr/bin/env bash
# The only writer of a task's INTENT.md: the developer's request, word for
# word, written once and kept read-only (0444) so no later stage can quietly
# rewrite what was actually asked for. The request is read from stdin through a
# quoted heredoc (<<'INTENT_EOF') so `$`, backticks and quotes survive; each
# line is prefixed with `> ` so a `## ...` line the developer typed cannot break
# the file's own sections. That prefix is the only change made to the text.
#
# Usage:
#   scripts/write-intent.sh --tasks-dir <abs> --slug <slug> --create \
#     --title "<title>" --repo <repo> \
#     --created-by <orchestrator|pipelinely-planning|pipelinely-dev> \
#     --source <free-text|backlog-item|milestone> \
#     [--links "<urls as given>"] [--criterion "<text>"]... [--out-of-scope "<text>"]... \
#     <<'INTENT_EOF'
#   <the developer's words, verbatim>
#   INTENT_EOF
#
#   scripts/write-intent.sh --tasks-dir <abs> --slug <slug> --amend --source "<label>" <<'INTENT_EOF'
#   <the new words, verbatim>
#   INTENT_EOF
#
# Exit codes: 0 ok · 1 I/O failure (stderr names the path) · 2 bad arguments,
# nothing touched · 3 --create but INTENT.md already exists · 4 --amend but
# there is no INTENT.md.
set -euo pipefail

readonly EXIT_IO_FAILURE=1
readonly EXIT_BAD_ARGS=2
readonly EXIT_ALREADY_EXISTS=3
readonly EXIT_NOTHING_TO_AMEND=4
readonly INTENT_FILE="INTENT.md"
readonly READ_ONLY_MODE=444
readonly NONE_STATED="- None stated by the developer."

fail() {
  local exit_code="$1"
  shift
  echo "write-intent: $*" >&2
  exit "$exit_code"
}

usage_fail() {
  fail "$EXIT_BAD_ARGS" "$* (usage: write-intent.sh --tasks-dir <abs> --slug <slug> --create|--amend ...; see the header of scripts/write-intent.sh)"
}

utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Prints stdin with every line prefixed by `> `.
quote_lines() {
  sed 's/^/> /'
}

# Prints one bullet per argument, or the "none stated" bullet when there are none.
print_bullets_or_none() {
  if [[ $# -eq 0 ]]; then
    echo "$NONE_STATED"
    return
  fi
  local item
  for item in "$@"; do
    echo "- $item"
  done
}

# Prints the `- M<N>:` bullet under `## Milestones` in a parent tech-design.md,
# byte for byte, so no LLM has to transcribe it.
extract_milestone_bullet() {
  local tech_design="$1" milestone_number="$2"
  awk -v prefix="- M${milestone_number}:" '
    /^## / { in_milestones = ($0 == "## Milestones"); next }
    in_milestones && index($0, prefix) == 1 { print; exit }
  ' "$tech_design"
}

TASKS_DIR_ARG=""
SLUG=""
MODE=""
TITLE=""
REPO=""
CREATED_BY=""
SOURCE=""
LINKS="none"
CRITERIA=()
OUT_OF_SCOPE=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --create | --amend)
      [[ -z "$MODE" ]] || usage_fail "--create and --amend are mutually exclusive"
      MODE="${1#--}"
      shift
      continue
      ;;
  esac
  [[ $# -ge 2 ]] || usage_fail "missing value for $1"
  case "$1" in
    --tasks-dir) TASKS_DIR_ARG="$2" ;;
    --slug) SLUG="$2" ;;
    --title) TITLE="$2" ;;
    --repo) REPO="$2" ;;
    --created-by) CREATED_BY="$2" ;;
    --source) SOURCE="$2" ;;
    --links) LINKS="$2" ;;
    --criterion) CRITERIA+=("$2") ;;
    --out-of-scope) OUT_OF_SCOPE+=("$2") ;;
    *) usage_fail "unknown argument: $1" ;;
  esac
  shift 2
done

[[ -n "$MODE" ]] || usage_fail "one of --create or --amend is required"
[[ "$TASKS_DIR_ARG" == /* ]] || usage_fail "--tasks-dir must be an absolute path"
[[ "$SLUG" =~ ^[A-Za-z0-9._-]+$ && "$SLUG" != "." && "$SLUG" != ".." ]] || usage_fail "--slug must match [A-Za-z0-9._-]+ and not be . or .."
[[ -n "$SOURCE" ]] || usage_fail "--source is required"

TASK_DIR="${TASKS_DIR_ARG%/}/$SLUG"
INTENT_PATH="$TASK_DIR/$INTENT_FILE"

# Reading stdin is part of validation: nothing on disk changes before every
# argument and the request itself are known to be good.
REQUEST="$(cat)"
HAS_REQUEST=false
[[ -n "${REQUEST//[[:space:]]/}" ]] && HAS_REQUEST=true

amend_intent() {
  [[ -f "$INTENT_PATH" ]] || fail "$EXIT_NOTHING_TO_AMEND" "no $INTENT_PATH to amend"
  [[ "$HAS_REQUEST" == true ]] || usage_fail "an amendment needs the new words on stdin"

  # The file is 0444 by design; it is writable only for this append, and the
  # trap puts the mode back on every exit path, including a failed append.
  trap 'chmod "$READ_ONLY_MODE" "$INTENT_PATH" 2>/dev/null || true' EXIT
  chmod u+w "$INTENT_PATH" || fail "$EXIT_IO_FAILURE" "cannot make $INTENT_PATH writable"
  {
    printf '\n### %s — %s\n' "$(utc_now)" "$SOURCE"
    printf '%s\n' "$REQUEST" | quote_lines
  } >>"$INTENT_PATH" || fail "$EXIT_IO_FAILURE" "cannot append to $INTENT_PATH"
}

create_intent() {
  [[ -n "$TITLE" && -n "$REPO" && -n "$CREATED_BY" ]] || usage_fail "--create needs --title, --repo and --created-by"
  case "$CREATED_BY" in
    orchestrator | pipelinely-planning | pipelinely-dev) ;;
    *) usage_fail "unknown --created-by: $CREATED_BY" ;;
  esac
  case "$SOURCE" in
    free-text | backlog-item | milestone) ;;
    *) usage_fail "unknown --source for --create: $SOURCE" ;;
  esac

  local source_line="$SOURCE" parent_intent_line="" milestone_scope=""
  if [[ "$SOURCE" == milestone ]]; then
    [[ "$SLUG" =~ ^(.+)-m([0-9]+)$ ]] || usage_fail "--source milestone needs a <parent>-m<N> slug, got $SLUG"
    local parent_slug="${BASH_REMATCH[1]}" milestone_number="${BASH_REMATCH[2]}"
    local parent_dir="${TASKS_DIR_ARG%/}/$parent_slug"
    local tech_design="$parent_dir/tech-design.md"
    [[ -f "$tech_design" ]] || usage_fail "no $tech_design to read milestone M${milestone_number} from"
    milestone_scope="$(extract_milestone_bullet "$tech_design" "$milestone_number")"
    [[ -n "$milestone_scope" ]] || usage_fail "no '- M${milestone_number}:' bullet under ## Milestones in $tech_design"
    source_line="milestone M${milestone_number} of ${parent_slug}"
    parent_intent_line="$parent_dir/$INTENT_FILE"
  elif [[ "$HAS_REQUEST" != true ]]; then
    usage_fail "an empty request cannot be recorded as intent"
  fi

  [[ ! -e "$INTENT_PATH" ]] || fail "$EXIT_ALREADY_EXISTS" "$INTENT_PATH already exists; use --amend to add to it"

  mkdir -p "$TASK_DIR" || fail "$EXIT_IO_FAILURE" "cannot create $TASK_DIR"

  # Written whole to a temp file, then hard-linked into place: `ln` without -f
  # fails atomically when the target exists, so of two racing creates exactly
  # one wins, and a failed write never leaves a half-written INTENT.md that
  # would block every later dispatch with exit 3.
  # Global, not local: the EXIT trap runs after this function has returned.
  temp_path="$TASK_DIR/.$INTENT_FILE.tmp.$$"
  trap 'rm -f "$temp_path"' EXIT
  {
    echo "# Intent: $TITLE"
    echo
    echo "- Slug: $SLUG"
    echo "- Repo: $REPO"
    echo "- Created: $(utc_now) by $CREATED_BY"
    echo "- Source: $source_line"
    [[ -z "$parent_intent_line" ]] || echo "- Parent intent: $parent_intent_line"
    echo "- Links: $LINKS"
    echo
    echo "## Original request (verbatim)"
    echo
    if [[ "$HAS_REQUEST" == true ]]; then
      printf '%s\n' "$REQUEST" | quote_lines
    else
      echo "This milestone has no request of its own; see the parent intent at $parent_intent_line."
    fi
    echo
    echo "## Acceptance criteria"
    echo
    print_bullets_or_none ${CRITERIA[@]+"${CRITERIA[@]}"}
    echo
    echo "## Out of scope / must not"
    echo
    print_bullets_or_none ${OUT_OF_SCOPE[@]+"${OUT_OF_SCOPE[@]}"}
    if [[ -n "$milestone_scope" ]]; then
      echo
      echo "## Milestone scope"
      echo
      echo "$milestone_scope"
    fi
    echo
    echo "## Amendments"
  } >"$temp_path" || fail "$EXIT_IO_FAILURE" "cannot write $temp_path"
  chmod "$READ_ONLY_MODE" "$temp_path" || fail "$EXIT_IO_FAILURE" "cannot chmod $temp_path"

  if ! ln "$temp_path" "$INTENT_PATH" 2>/dev/null; then
    [[ ! -e "$INTENT_PATH" ]] || fail "$EXIT_ALREADY_EXISTS" "$INTENT_PATH already exists; use --amend to add to it"
    fail "$EXIT_IO_FAILURE" "cannot link $INTENT_PATH into place"
  fi
}

case "$MODE" in
  create) create_intent ;;
  amend) amend_intent ;;
esac
