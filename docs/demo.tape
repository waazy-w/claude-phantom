# VHS tape for the README demo GIF.
# Docs: https://github.com/charmbracelet/vhs
#
# Usage (from the claude-phantom repo root):
#
#   PHANTOM_REPO="$PWD" vhs docs/demo.tape
#
# Requires: vhs, ttyd, ffmpeg, a working `phantom` on PATH (npm link), and an
# authenticated `claude` CLI. The hidden setup block copies examples/crash-demo
# into a fresh temp git repo so the recording never touches this checkout.
#
# Recovery takes 60-120 s of real time. The Sleep below is generous; trim the
# resulting GIF with `Set PlaybackSpeed` or cut idle time in an editor so the
# final GIF stays under ~30 s.

Output docs/demo.gif

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
Set PlaybackSpeed 1.0

# --- hidden setup: temp repo with the crashing demo app ---------------------
Hide
Type 'DEMO="$(mktemp -d)" && cp -R "$PHANTOM_REPO/examples/crash-demo/." "$DEMO" && cd "$DEMO" && git init -q && git -c user.name=demo -c user.email=demo@example.com add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "init" && clear'
Enter
Sleep 1s
Show

# --- the recording ----------------------------------------------------------
Type "phantom npm start"
Sleep 500ms
Enter

# app output, crash, banner, recovery phases
Sleep 90s

Type "clear"
Enter
Sleep 300ms

Type "cat .phantom/reports/*.md | head -40"
Sleep 500ms
Enter
Sleep 6s

Type "git branch --list 'phantom/*'"
Sleep 300ms
Enter
Sleep 4s
