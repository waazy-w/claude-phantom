#!/usr/bin/env sh
# Claude Code status line that appends phantom's 👻 segment to whatever you
# already show. Point "statusLine.command" in ~/.claude/settings.json at this
# file (or copy it anywhere on disk), and put your existing status-line
# command in BASE below. Leave BASE empty to show only phantom's segment.
#
# Claude Code pipes a JSON blob on stdin; both commands need it, so it is read
# once and replayed to each.

BASE=""   # e.g. BASE="$HOME/.claude/my-statusline.sh"

input=$(cat)
phantom=$(printf '%s' "$input" | phantom-status 2>/dev/null)

if [ -n "$BASE" ]; then
  base=$(printf '%s' "$input" | sh -c "$BASE" 2>/dev/null | head -n 1)
  if [ -n "$phantom" ]; then printf '%s  %s\n' "$base" "$phantom"; else printf '%s\n' "$base"; fi
else
  printf '%s\n' "$phantom"
fi
