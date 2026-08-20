# VHS tape for the README demo GIF.
# Docs: https://github.com/charmbracelet/vhs
#
# Usage (from the claude-phantom repo root):
#
#   PHANTOM_REPO="$PWD" vhs docs/demo.tape
#
# Requires: vhs, ttyd, ffmpeg, a working `phantom` on PATH (npm link or a global
# install), and an authenticated `claude` CLI. The hidden setup block copies
# examples/crash-demo into a fresh temp git repo so the recording never touches
# this checkout.
#
# The recording runs a genuine `claude -p` session (1-2 minutes on the demo
# app), so it draws on whatever that CLI is signed in to: a Pro/Max plan's usage
# allowance, or real API dollars if ANTHROPIC_API_KEY is set. Either way the
# take is worth protecting, so the tape records only an MP4 master and sleeps
# far longer than a recovery needs;
# `docs/make-demo-gif.sh` then cuts the idle stretch and renders the GIF, as
# many times as you like, without re-recording.
#
# (vhs 0.11's `Wait+Screen` would be the natural way to end on the completion
# banner, but it hangs in this tape, so the sleep is deliberately generous.)

Output docs/demo.mp4

Require phantom
Require claude
Require git

Set Shell "bash"
Set FontSize 15
Set Width 960
Set Height 560
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 30
Set PlaybackSpeed 1.0

# --- hidden setup: temp repo with the crashing demo app ---------------------
Hide
Type 'DEMO="$(mktemp -d)" && cp -R "$PHANTOM_REPO/examples/crash-demo/." "$DEMO" && cd "$DEMO" && rm -f setup-demo.sh && git init -q && git -c user.name=demo -c user.email=demo@example.com add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "init" && clear'
Enter
Sleep 2s
Show

# --- the recording ----------------------------------------------------------
Type "phantom npm start"
Sleep 500ms
Enter

# App output, crash, then phantom takes over: branch, claude session, an
# independent test run, commit, banner. A recovery on this demo takes 1-2 min;
# the surplus is idle terminal and gets cut in post.
Sleep 420s

Type "clear"
Enter
Sleep 300ms

Type "head -40 .phantom/reports/*.md"
Sleep 500ms
Enter
Sleep 8s

Type "git branch --list 'phantom/*'"
Sleep 300ms
Enter
Sleep 4s
