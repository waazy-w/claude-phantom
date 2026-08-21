# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-08-21

### Fixed

- The end-of-recovery prompt never waited for an answer. It read from `process.stdin`, but
  the recovery session is a long-lived child that takes the controlling terminal, and once
  it exits the inherited stdin no longer delivers a line -- readline saw end-of-input and
  closed, so the question printed and vanished and the keystroke landed in the shell
  instead. The prompt now reads from `/dev/tty`, a fresh handle on the same terminal that
  is unaffected by whatever the child did, falling back to `process.stdin` on Windows and
  where there is no controlling terminal. Whether to prompt at all is still decided by
  `process.stdin.isTTY`, so a piped stdin in a script or CI still gets no prompt even
  though `/dev/tty` would supply one.
- The terminal is opened as a `tty.ReadStream` rather than a plain file stream, so readline
  can turn off the driver's own echo. Without `setRawMode` both echoed and every keystroke
  appeared twice.

## [0.3.1] - 2026-08-21

### Changed

- The token figure now shows what was actually new: `468.2k tokens (12.2k new · 456k
  cached)`. A bare total is honest but uninterpretable -- a one-iteration recovery reports
  something like 468k, which reads as enormous until you know ~97% of it is the same system
  prompt and the same files re-read every turn and billed as cache reads at a fraction of
  the input rate.

## [0.3.0] - 2026-08-21

### Fixed

- **Windows support.** The suite now runs green on `windows-latest` across Node 18/20/22/24,
  and the leg gates the build like any other. Five real bugs came out of it, all of them
  reachable by a Windows user today:
  - `shell: true` on win32 (in both the wrapped command and the Claude session) let cmd.exe
    re-parse the argv. Quoted arguments were mangled, phantom's own `--settings` JSON and
    `--allowedTools` entries were shredded, and `ENOENT` never fired so a missing binary
    exited 1 instead of 127. Only a resolved `.cmd`/`.bat` shim now goes through cmd, with
    each argument escaped for it.
  - The guard hook failed open. Stripping backslashes to undo shell escaping also destroyed
    Windows path separators, so `C:\Users\me\.env` stopped matching the never-touch globs
    and the guard permitted the write.
  - A killed recovery kept running. With a `.cmd` shim the spawned process is cmd.exe and
    the work is a grandchild, so `child.kill()` left it alive -- a `maxMinutes` timeout or a
    Ctrl+C stopped watching but did not stop Claude. Now killed with `taskkill /T`.
  - `git rev-parse --show-toplevel` prints `/` separators even on Windows, so comparisons
    against `process.cwd()` never matched and stack-trace paths were made relative to the
    wrong directory.
  - CRLF was a publishing hazard: a package published from a Windows checkout would ship
    `bin/*.js` whose `#!/usr/bin/env node` carried a CR, which POSIX kernels refuse to exec.
    `.gitattributes` pins LF.

  Six tests skip on Windows because the platform cannot express them: libuv maps
  SIGTERM/SIGINT/SIGKILL onto an unconditional `TerminateProcess`, so a killed child never
  reports a signal and a target's own handler cannot run. `phantom dir` and other cmd
  built-ins are no longer wrapped, matching POSIX behaviour.

### Added

- `test/windows-spawn.test.js`: the cmd.exe argument escaping is exercised by modelling
  cmd's parser and the MSVC CRT rules and round-tripping every escaped argument back, since
  CI never reaches that branch.

## [0.2.0] - 2026-08-21

### Added

- A spinner with an elapsed-time counter while the Claude session runs. The session prints
  nothing for minutes at a time, so there was no way to tell work from a hang. It animates
  only on a TTY, and stays silent under `--verbose`, where the session already streams to
  the same stderr.

- After a verified fix, phantom asks whether to merge the branch into your branch, delete
  it, or keep it for later. It only asks when it can safely act on the answer: a verified
  fix, a branch that still exists, the user back on their own branch, a clean tree, and no
  stash left outstanding. Non-interactive sessions, `--no-prompt`, and
  `"promptOnFinish": false` skip it, and every non-answer -- EOF, Ctrl+C, the two-minute
  timeout, three unrecognised replies -- leaves the branch exactly as it was. A conflicting
  merge is reported rather than unwound, since `--abort` would discard a resolvable merge.

- `--no-prompt` flag and `promptOnFinish` config key to turn that prompt off.
- `scripts/run-tests.js` runs the suite from an explicit file list instead of a shell glob,
  so `npm test` behaves the same on Windows, and exits 1 rather than 0 when the list comes
  back empty -- a glob that matches nothing otherwise looks like a green suite.
- CI runs the suite on `windows-latest` as well. It is non-blocking: 29 of 210 tests fail
  there today (argument quoting through cmd.exe, POSIX signals, exec bits, path formats),
  and the leg exists so that gap stays measured rather than assumed.

### Changed

- Recovery spend is reported in tokens rather than dollars, in the finish banner and in the
  post-mortem's `Model / tokens` and `Tokens` rows. A dollar figure reads as what the user
  was charged, which it is not: the rate depends on the model and on whether the session
  bills against a subscription or an API key, so the same recovery is a different amount of
  money for different people. The total counts prompt, completion, and both halves of the
  cache -- omitting cache reads would understate a resumed session by an order of magnitude.
  The post-mortem template placeholder `{{modelCost}}` is now `{{modelUsage}}`.
- `package.json`'s `homepage` and the README now point at https://claudephantom.dev.

## [0.1.1] - 2026-08-21

### Fixed

- README pointed at `bash docs/make-demo-gif.sh` for re-rendering the demo; the script is
  `docs/make-demo-gif.js` and runs under node. Following the old line failed outright.
- The ring-buffer memory test collected once before sampling, which measured V8's
  background ArrayBuffer sweeper rather than what the ring retains and failed
  intermittently. It now collects twice and asserts a one-chunk bound.

### Added

- `test/ansi.test.js`: direct coverage for `src/ansi.js`, the last module without a test
  file. Pins both OSC terminators, the null/undefined path, and the rejoining of a path or
  secret split mid-token by an escape -- the case the redactor depends on.
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

[Unreleased]: https://github.com/waazy-w/claude-phantom/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/waazy-w/claude-phantom/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/waazy-w/claude-phantom/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/waazy-w/claude-phantom/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/waazy-w/claude-phantom/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/waazy-w/claude-phantom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/waazy-w/claude-phantom/releases/tag/v0.1.0
