#!/usr/bin/env bash
# Claude Code status line script
# Displays: project | git branch | model | tokens/context% | elapsed time
# Requires: jq

input=$(cat)

# --- Model ---
model_name=$(echo "$input" | jq -r '.model.display_name // "Unknown"')
model_short=$(echo "$model_name" | sed \
  -e 's/Claude 3\.5 Haiku/Haiku 3.5/g' \
  -e 's/Claude 3\.5 Sonnet/Sonnet 3.5/g' \
  -e 's/Claude 3 Opus/Opus 3/g' \
  -e 's/Claude Opus 4\.6/Opus 4.6/g' \
  -e 's/Claude Opus 4\.5/Opus 4.5/g' \
  -e 's/Claude Opus 4/Opus 4/g' \
  -e 's/Claude Sonnet 4\.6/Sonnet 4.6/g' \
  -e 's/Claude Sonnet 4\.5/Sonnet 4.5/g' \
  -e 's/Claude Sonnet 4/Sonnet 4/g' \
  -e 's/Claude Haiku 4\.5/Haiku 4.5/g' \
  -e 's/Claude Haiku 4/Haiku 4/g' \
)

# --- Working directory / project ---
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
project_dir=$(echo "$input" | jq -r '.workspace.project_dir // ""')
if [ -n "$project_dir" ] && [ "$project_dir" != "null" ]; then
  project_name=$(basename "$project_dir")
else
  project_name=$(basename "$cwd")
fi
display_cwd=$(echo "$cwd" | sed "s|^$HOME|~|")

# --- Git info ---
git_info=""
if [ -n "$cwd" ] && [ "$cwd" != "null" ]; then
  git_branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null)
  if [ -n "$git_branch" ]; then
    git_dirty=$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)
    if [ -n "$git_dirty" ]; then
      git_info="${git_branch}*"
    else
      git_info="${git_branch}"
    fi
  fi
fi

# --- Worktree info ---
worktree_name=$(echo "$input" | jq -r '.worktree.name // empty')
worktree_branch=$(echo "$input" | jq -r '.worktree.branch // empty')

# --- Localhost :7100 serving indicator ---
# Detects whether the rspack dev server on :7100 traces back to THIS worktree
# (vs another worktree running a parallel react-dev), or is not running at all.
serving_status=""
serving_state=""  # "this" | "other" | "down"
if [ -n "$cwd" ] && [ "$cwd" != "null" ]; then
  worktree_root=$(git -C "$cwd" --no-optional-locks rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$worktree_root" ]; then
    listener_pid=$(lsof -nP -iTCP:7100 -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $2}')
    if [ -z "$listener_pid" ]; then
      serving_state="down"
      serving_status=":7100 ✘"
    else
      pid=$listener_pid
      for _ in 1 2 3 4 5 6 7 8; do
        if [ -z "$pid" ] || [ "$pid" = "1" ] || [ "$pid" = "0" ]; then break; fi
        cmd=$(ps -p "$pid" -o command= 2>/dev/null)
        if [ -z "$cmd" ]; then break; fi
        if [[ "$cmd" == *"$worktree_root"* ]]; then
          serving_state="this"
          break
        fi
        pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
      done
      if [ "$serving_state" = "this" ]; then
        serving_status=":7100 ✓"
      else
        serving_state="other"
        serving_status=":7100 ⚠ other"
      fi
    fi
  fi
fi

# --- Token / context usage ---
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
total_in=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
total_out=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')

format_tokens() {
  local n=$1
  if [ "$n" -ge 1000 ] 2>/dev/null; then
    printf "%.1fk" "$(echo "scale=1; $n / 1000" | bc 2>/dev/null || echo 0)"
  else
    echo "${n}"
  fi
}

total_in_fmt=$(format_tokens "$total_in")
total_out_fmt=$(format_tokens "$total_out")

# --- Session elapsed time ---
transcript_path=$(echo "$input" | jq -r '.transcript_path // ""')
elapsed_str=""
if [ -n "$transcript_path" ] && [ "$transcript_path" != "null" ] && [ -f "$transcript_path" ]; then
  first_ts=$(head -1 "$transcript_path" 2>/dev/null | jq -r '.timestamp // empty' 2>/dev/null)
  now_ts=$(date +%s)
  if [ -n "$first_ts" ] && [ "$first_ts" != "null" ]; then
    start_ts=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${first_ts%%.*}" "+%s" 2>/dev/null)
    if [ -z "$start_ts" ]; then
      start_ts=$(date -d "${first_ts%%.*}" "+%s" 2>/dev/null)
    fi
    if [ -n "$start_ts" ]; then
      elapsed_secs=$((now_ts - start_ts))
      if [ "$elapsed_secs" -ge 3600 ]; then
        elapsed_str=$(printf "%dh%02dm" $((elapsed_secs/3600)) $(((elapsed_secs%3600)/60)))
      elif [ "$elapsed_secs" -ge 60 ]; then
        elapsed_str=$(printf "%dm%02ds" $((elapsed_secs/60)) $((elapsed_secs%60)))
      else
        elapsed_str="${elapsed_secs}s"
      fi
    fi
  fi
fi

# --- Optional extras ---
session_name=$(echo "$input" | jq -r '.session_name // empty')
vim_mode=$(echo "$input" | jq -r '.vim.mode // empty')
output_style=$(echo "$input" | jq -r '.output_style.name // empty')

# --- ANSI colors ---
RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"
CYAN="\033[36m"
YELLOW="\033[33m"
GREEN="\033[32m"
BLUE="\033[34m"
RED="\033[31m"

SEP="${DIM}|${RESET}"

parts=()

# 1. Project name + path
parts+=("$(printf "${BOLD}${BLUE}%s${RESET} ${DIM}%s${RESET}" "$project_name" "$display_cwd")")

# 2. Git branch (yellow=dirty, green=clean) + worktree
if [ -n "$worktree_name" ]; then
  wt_label="${worktree_name}${worktree_branch:+ ($worktree_branch)}"
  if [[ "$git_info" == *"*" ]]; then
    parts+=("$(printf "${YELLOW}%s${RESET} ${DIM}worktree${RESET}" "$wt_label")")
  else
    parts+=("$(printf "${GREEN}%s${RESET} ${DIM}worktree${RESET}" "$wt_label")")
  fi
elif [ -n "$git_info" ]; then
  if [[ "$git_info" == *"*" ]]; then
    parts+=("$(printf "${YELLOW}%s${RESET}" "$git_info")")
  else
    parts+=("$(printf "${GREEN}%s${RESET}" "$git_info")")
  fi
fi

# 2.5. Localhost :7100 serving indicator
if [ -n "$serving_status" ]; then
  case "$serving_state" in
    this)  parts+=("$(printf "${GREEN}%s${RESET}" "$serving_status")") ;;
    other) parts+=("$(printf "${YELLOW}%s${RESET}" "$serving_status")") ;;
    down)  parts+=("$(printf "${RED}%s${RESET}" "$serving_status")") ;;
  esac
fi

# 3. Model
parts+=("$(printf "${CYAN}%s${RESET}" "$model_short")")

# 4. Tokens + context %
token_str="${total_in_fmt}in ${total_out_fmt}out"
if [ -n "$used_pct" ]; then
  used_pct_int=$(printf "%.0f" "$used_pct" 2>/dev/null || echo "")
  if [ -n "$used_pct_int" ]; then
    if [ "$used_pct_int" -ge 80 ]; then
      token_str="${token_str} ${RED}ctx:${used_pct_int}%${RESET}"
    elif [ "$used_pct_int" -ge 50 ]; then
      token_str="${token_str} ${YELLOW}ctx:${used_pct_int}%${RESET}"
    else
      token_str="${token_str} ${DIM}ctx:${used_pct_int}%${RESET}"
    fi
  fi
fi
parts+=("$token_str")

# 5. Elapsed time
if [ -n "$elapsed_str" ]; then
  parts+=("$(printf "${DIM}%s${RESET}" "$elapsed_str")")
fi

# 6. Session name
if [ -n "$session_name" ] && [ "$session_name" != "null" ]; then
  parts+=("$(printf "${DIM}[%s]${RESET}" "$session_name")")
fi

# 7. Vim mode
if [ -n "$vim_mode" ]; then
  if [ "$vim_mode" = "NORMAL" ]; then
    parts+=("$(printf "${BOLD}${RED}NORMAL${RESET}")")
  else
    parts+=("$(printf "${BOLD}${GREEN}INSERT${RESET}")")
  fi
fi

# 8. Output style (if non-default)
if [ -n "$output_style" ] && [ "$output_style" != "null" ] && [ "$output_style" != "default" ] && [ "$output_style" != "Default" ]; then
  parts+=("$(printf "${DIM}style:%s${RESET}" "$output_style")")
fi

# Join with separator
result=""
for part in "${parts[@]}"; do
  if [ -z "$result" ]; then
    result="$part"
  else
    result="${result} ${SEP} ${part}"
  fi
done

printf "%b\n" "$result"

# Cockpit AI: write per-task metrics if this is a cockpit-ai worker session
if [ -n "$COCKPIT_TASK_SLUG" ]; then
  TASK_DIR="${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/$COCKPIT_TASK_SLUG"
  if [ -d "$TASK_DIR" ]; then
    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Legacy single-file snapshot — unchanged shape, still the fallback for
    # task dirs that predate per-session files.
    echo "$input" | jq --arg ts "$NOW" '{
      contextPct: (.context_window.used_percentage // null),
      inputTokens: (.context_window.total_input_tokens // 0),
      outputTokens: (.context_window.total_output_tokens // 0),
      model: (.model // null),
      updatedAt: $ts
    }' > "$TASK_DIR/METRICS" 2>/dev/null || true

    # One file per Claude session. Without this, a task dir's plan-review, QA
    # and CR sessions each overwrite the one before, and only the last
    # survives to be shown.
    SESSION_ID=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
    [ -z "$SESSION_ID" ] && SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
    if [ -n "$SESSION_ID" ]; then
      SESSION_FILE="$TASK_DIR/METRICS-$SESSION_ID.json"
      # startedAt is written once and then carried forward, so it keeps
      # meaning "when this session began" rather than "when it last rendered".
      STARTED=$(jq -r '.startedAt // empty' "$SESSION_FILE" 2>/dev/null)
      [ -z "$STARTED" ] && STARTED="$NOW"
      if echo "$input" | jq \
        --arg sid "$SESSION_ID" \
        --arg stage "${COCKPIT_STAGE:-}" \
        --arg started "$STARTED" \
        --arg ts "$NOW" '{
          sessionId: $sid,
          stage: (if $stage == "" then null else $stage end),
          contextPct: (.context_window.used_percentage // null),
          inputTokens: (.context_window.total_input_tokens // 0),
          outputTokens: (.context_window.total_output_tokens // 0),
          model: (.model // null),
          startedAt: $started,
          updatedAt: $ts
        }' > "$SESSION_FILE.tmp" 2>/dev/null; then
        mv "$SESSION_FILE.tmp" "$SESSION_FILE"
      else
        rm -f "$SESSION_FILE.tmp"
      fi
    fi
  fi
fi
