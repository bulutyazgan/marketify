#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--tool amp|claude] [max_iterations]

set -e

# Parse arguments
TOOL="amp"  # Default to amp for backwards compatibility
MAX_ITERATIONS=10

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      fi
      shift
      ;;
  esac
done

# Validate tool choice
if [[ "$TOOL" != "amp" && "$TOOL" != "claude" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp' or 'claude'."
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")
  
  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"
    
    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"
    
    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

echo "Starting Ralph - Tool: $TOOL - Max iterations: $MAX_ITERATIONS"

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($TOOL)"
  echo "==============================================================="

  # Run the selected tool with the ralph prompt
  if [[ "$TOOL" == "amp" ]]; then
    OUTPUT=$(cat "$SCRIPT_DIR/prompt.md" | amp --dangerously-allow-all 2>&1 | tee /dev/stderr) || true
  else
    # Claude Code: stream-json output format emits NDJSON (one event per tool_use / message / result).
    # We pipe it through jq to produce human-readable lines ([TOOL], [TXT], [RES], [DONE]) that land
    # in $ITER_OUT and stream to ralph.log via tail -F.
    #
    # Watchdog strategy (two-tier, progress-aware):
    #   IDLE  : kill the worker if no NDJSON has been written to $ITER_OUT for MAX_IDLE_SECONDS.
    #           This is the real failure mode — MCP stdio deadlock where the worker goes silent.
    #           A working iter resets the idle clock on every tool call.
    #   TOTAL : hard ceiling in case the worker is "alive but pathological" (tight tool-call loop
    #           with no meaningful progress). Generous — only trips on clearly broken runs.
    MAX_IDLE_SECONDS=${MAX_IDLE_SECONDS:-900}     # 15 min of silence = stuck
    MAX_TOTAL_SECONDS=${MAX_TOTAL_SECONDS:-7200}  # 2 hour hard ceiling
    ITER_OUT=$(mktemp -t ralph-iter) || ITER_OUT="/tmp/ralph-iter-$$"
    RAW_OUT=$(mktemp -t ralph-raw)  || RAW_OUT="/tmp/ralph-raw-$$"
    : > "$ITER_OUT" ; : > "$RAW_OUT"

    JQ_FILTER='
if .type == "system" and .subtype == "init" then
  "[INIT] session=\(.session_id // "?") model=\(.model // "?") cwd=\(.cwd // "?")"
elif .type == "assistant" then
  (.message.content // [] | map(
    if .type == "text" then
      ("[TXT] " + (.text | gsub("\n"; " / ") | if (length // 0) > 500 then .[:500] + "..." else . end))
    elif .type == "tool_use" then
      ("[TOOL] " + .name + " " + ((.input // {}) | tojson | if length > 500 then .[:500] + "..." else . end))
    elif .type == "thinking" then
      ("[THINK] " + (.thinking // "" | gsub("\n"; " / ") | if (length // 0) > 300 then .[:300] + "..." else . end))
    else empty end
  ) | .[])
elif .type == "user" then
  (.message.content // [] | map(
    if .type == "tool_result" then
      (. as $tr
       | ($tr.content | if type == "array" then map(.text // "") | join(" ") else tostring end) as $txt
       | ("[RES] " + ($txt | gsub("\n"; " / ") | if (length // 0) > 300 then .[:300] + "..." else . end)))
    else empty end
  ) | .[])
elif .type == "result" then
  ("[DONE] subtype=" + (.subtype // "?") + " turns=" + ((.num_turns // 0) | tostring) + " duration=" + ((.duration_ms // 0) | tostring) + "ms")
else empty end
'

    # Live-stream $ITER_OUT to stdout (ralph.log) so every formatted line appears in real time.
    tail -F "$ITER_OUT" 2>/dev/null &
    TAIL_PID=$!

    # Reformat NDJSON from claude's stdout → human-readable lines in $ITER_OUT.
    ( tail -F "$RAW_OUT" 2>/dev/null | jq --unbuffered -r "$JQ_FILTER" 2>/dev/null >> "$ITER_OUT" ) &
    JQ_PIPE_PID=$!

    # stdout → RAW_OUT (NDJSON), stderr → $ITER_OUT (errors show up directly in the log).
    claude --dangerously-skip-permissions --output-format stream-json --verbose --print \
      < "$SCRIPT_DIR/CLAUDE.md" > "$RAW_OUT" 2>> "$ITER_OUT" &
    CLAUDE_PID=$!

    # Inactivity watchdog — poll $ITER_OUT mtime every 30s. If the worker hasn't
    # emitted any NDJSON for $MAX_IDLE_SECONDS, assume MCP deadlock and terminate.
    # A productive iter (tool calls streaming in) continuously resets the clock.
    (
      while kill -0 "$CLAUDE_PID" 2>/dev/null; do
        sleep 30
        now=$(date +%s)
        mtime=$(stat -f %m "$ITER_OUT" 2>/dev/null || stat -c %Y "$ITER_OUT" 2>/dev/null || echo "$now")
        idle=$(( now - mtime ))
        if [ "$idle" -gt "$MAX_IDLE_SECONDS" ]; then
          echo "[WATCHDOG] No output for ${idle}s (> ${MAX_IDLE_SECONDS}s) — killing worker" >> "$ITER_OUT"
          kill -TERM "$CLAUDE_PID" 2>/dev/null
          sleep 10
          kill -KILL "$CLAUDE_PID" 2>/dev/null
          exit 0
        fi
      done
    ) &
    IDLE_PID=$!

    # Total-time ceiling — safety net for "alive but looping forever" pathologies.
    ( sleep "$MAX_TOTAL_SECONDS"; kill -TERM "$CLAUDE_PID" 2>/dev/null; sleep 10; kill -KILL "$CLAUDE_PID" 2>/dev/null ) &
    WATCHDOG_PID=$!

    wait "$CLAUDE_PID" 2>/dev/null || true
    sleep 2  # let jq drain any final NDJSON lines before we tear it down

    # Clean up the jq pipeline and its children.
    pkill -P "$JQ_PIPE_PID" 2>/dev/null || true
    kill "$JQ_PIPE_PID" 2>/dev/null || true
    wait "$JQ_PIPE_PID" 2>/dev/null || true

    kill "$TAIL_PID"     2>/dev/null || true; wait "$TAIL_PID"     2>/dev/null || true
    kill "$IDLE_PID"     2>/dev/null || true; wait "$IDLE_PID"     2>/dev/null || true
    kill "$WATCHDOG_PID" 2>/dev/null || true; wait "$WATCHDOG_PID" 2>/dev/null || true

    OUTPUT=$(cat "$ITER_OUT" 2>/dev/null || true)
    rm -f "$ITER_OUT" "$RAW_OUT"
  fi
  
  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all tasks!"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    exit 0
  fi
  
  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
