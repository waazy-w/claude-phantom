# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/make-demo-gif.js`: renders `docs/demo.gif` from the `docs/demo.mp4` master that
  `docs/demo.tape` records. It caps every visually static span (found with ffmpeg's
  `freezedetect`) so the long wait while Claude works is compressed while the readable
  parts stay at real speed. Recording costs plan usage; re-rendering is free.

### Changed

- `docs/demo.tape` records an MP4 master rather than a GIF, and waits well past a normal
  recovery instead of a fixed 90 s that could cut a slow run off mid-session.
- The README no longer describes the demo as a "billed" session: with a Pro/Max login it
  draws on the plan's usage allowance, and the `total_cost_usd` phantom prints is Claude
  Code's API-rate estimate, not a charge.

## [0.1.0] - 2026-08-20

### Added

- `phantom <command>` wrapper: byte-for-byte passthrough of stdout/stderr, exit code
  preserved, last 256 KiB of output kept in a ring buffer.
- Exit-based crash detection (non-zero exit or signal death, excluding the user's own
  Ctrl+C) with stack-trace extraction, error-line detection, and hint-file discovery.
- Crash context capture: output tail, git branch/HEAD/status/recent commits, `package.json`
  name and scripts, persisted as JSON under `.phantom/crashes/`.
- Headless recovery via `claude -p` on a dedicated `phantom/fix-<slug>-<ts>` branch:
  diagnose, write a failing regression test, apply a minimal patch, independent test
  verification loop (`maxIterations`), wall-clock cap (`maxMinutes`).
- Safety rails: clean-tree requirement (`--allow-dirty` takes a stash snapshot), minimal
  allowed-tools list, never-touch globs enforced as Claude Code permission deny rules and
  as a post-run diff audit that hard-reverts the fix branch on violation, no network tools,
  no pushes, Ctrl+C kill switch that restores the original branch.
- `--dry-run` mode: read-only tools, diagnosis and proposed diff written to the report,
  nothing else touched.
- Post-mortem report written from `templates/post-mortem.md` to `.phantom/reports/`, with
  an independent verification section appended by phantom; fallback report when Claude
  produces none.
- Configuration via `.phantomrc` or the `"phantom"` key in `package.json`; CLI flags override.
- Optional webhook notification on completion.
- `PHANTOM_DISABLED=1` escape hatch for pure passthrough.
- Claude Code plugin (`plugin/`): `/phantom:recover` command and `crash-recovery` skill.
- Event log `.phantom/events.jsonl`: phantom records every detected crash and every recovery outcome.
- Claude Code plugin hooks (`UserPromptSubmit`, `SessionStart`) that tell Claude about unread phantom events at the start of your next message.
- `phantom-status`: a status-line segment (👻 fixing / fixed / crashed) for Claude Code, plus `examples/statusline.sh` to combine it with an existing status line.
- `--notify` flag / `notify` config key: desktop notification on crash and when recovery ends (macOS `osascript`, or `terminal-notifier` with the phantom icon when installed; Linux `notify-send`).
- Brand kit in `brand/`: green phantom mark, wordmark, favicon, social preview, and `BRAND.md`.
- Terminal escape sequences are stripped from the captured output before anything reads it,
  so colourised child processes (`FORCE_COLOR`, CI runners, test frameworks) cannot corrupt
  hint-file paths, the error line, the branch slug, or the post-mortem — and cannot hide a
  secret from the redactor by splitting it mid-token.
- Post-mortem and completion banner include the Claude Code session id (`claude --resume <id>`).
- The recovery session loads only project and local settings (`--setting-sources project,local`): user-level hooks, permission allows, installed plugins, and their MCP servers are not loaded into it. Phantom's own deny rules and guard hook still apply.
- `examples/crash-demo`: a deliberately crashing sample app with `node:test` tests.
- Zero runtime dependencies; Node >= 18.

[Unreleased]: https://github.com/waazy-w/claude-phantom/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/waazy-w/claude-phantom/releases/tag/v0.1.0
