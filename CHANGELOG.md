# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-08-22

Continues the audit that produced 0.3.6, taking the two findings that were held back
because they change behaviour rather than only fixing it.

### Fixed

- **Concurrent crashes destroyed the event log.** `appendEvent` read the whole file,
  concatenated, and wrote it back with no lock, so two phantom-wrapped commands crashing
  at once — a monorepo, `npm-run-all -p`, a CI matrix, two terminals — had each writer
  read a snapshot the other was mid-truncate on and write that shorter version back as
  the authoritative log. Measured at 6 writers × 10 events against a full log: 38, then
  22, then 54 of the 60 new events gone. Not torn lines; the file simply shrank. Writes
  are now a bare `O_APPEND`, which is atomic against other appenders.
- **Readers could catch the log and the cursor mid-write.** Rewriting in place left a
  window where a concurrent reader saw an empty or truncated file — ~1% of reads under
  load, and `phantom-status` runs on every status-line render. An empty cursor is worse
  than an empty log: it replays everything as unread. Both are now written to a sibling
  and renamed, which is atomic. The plugin's copy of `markRead` got the same treatment.
- **One crash could inject 200 KB into every Claude Code prompt.** `error` is a line of
  the crashed program's own output and nothing bounded it, so a minified bundle or a
  single-line JSON blob went verbatim into the log and from there into
  `additionalContext` on every prompt in that repo — about 50k tokens of the user's
  context window per event. `error`, `command` and `message` are now clamped, with the
  truncation visible rather than silent.
- **`--dry-run` did not restrict Bash, and never checked what happened.** The file tools
  refused every write under `--dry-run` from the start, but `checkBash` had no dry-run
  branch at all, so `echo patched > src/app.js`, `sed -i` and `tee` all went through. Dry
  run is the worst place for that gap: it creates no branch, so the writes landed on the
  user's own checked-out branch with nothing to roll them back — while the banner said
  "nothing changed", the report said "Files changed | none", and the never-touch row
  claimed a hard revert that had never happened. Now: Bash writes are refused, the tree
  is measured in dry run too, and anything that still got through is named, undone
  file-by-file, and reported as an `error` rather than a clean dry run.
- **A failed never-touch revert was still announced as a discard.** `resetHard` and
  `cleanUntracked` return values were dropped, so a stale `index.lock` was enough to make
  phantom's strongest safety claim false while the edits stayed on disk.
- The post-mortem's never-touch row no longer hardcodes "(branch hard-reverted)"; it
  states what actually happened, which in a dry run is that there was no branch at all.

### Changed

- **`MAX_EVENTS` is a ceiling, not an exact length.** The whole-file rewrite that enforces
  it now runs only once the log crosses 1.5× the cap, and under a lock, so the common path
  stays a lock-free atomic append. Between trims the log may hold up to 300 lines.
- The dry-run undo is deliberately surgical — `git checkout HEAD -- <paths>` for tracked
  files, `unlink` for files the session created. `reset --hard` would be catastrophic
  here: dry run takes no stash, so the user's own uncommitted work shares the tree.

## [0.3.6] - 2026-08-22

Found by an audit that ran the code in places the suite never had: behind a pipe, in a
worktree, with a second stash on the stack, and with credentials in argv. Every fix below
has a regression test, and every test was mutation-checked against the 0.3.5 behaviour.

### Fixed

- **Following phantom's own recovery instructions destroyed the user's work.** When
  phantom left you on the fix branch it skipped popping your snapshot stash — the guard
  read `!s.onPhantomBranch`, which is still true there — and then printed
  `git stash && git checkout main`. Running that put phantom's *unverified* patch on the
  branch phantom had just called untouched, lost the tree state you had, and buried your
  real work under a stash you were told you had already restored. The stash is now
  restored on that path, and the printed sequence is verified by a test that executes it
  verbatim and asserts the user gets their work back.
- **`phantom -- cmd | head` (or `| grep -q`, or quitting the pager) hung forever.** On
  EPIPE the pump called `src.unpipe(dest)`, which also clears flowing mode; the
  ring-buffer `data` listener does not bring it back, so the child's stdout was never
  drained again and a child that writes synchronously to fd 1 — most programs that are
  not node — blocked on a full pipe with nothing to settle the run.
- **Phantom was unusable in a git worktree or submodule.** `.git` is a file there, so
  `ensureExcluded` threw `ENOTDIR`, swallowed it, and never excluded `.phantom/` — leaving
  `git status --porcelain` permanently dirty and every crash refused with "uncommitted
  changes". Resolved through `git rev-parse --git-common-dir`.
- **`git stash pop` took whatever was on top of the stack.** A stash pushed by another
  shell, a `git pull --autostash`, or a second phantom run meant phantom restored a
  stranger's content over the tree and reported success, with the real work still buried.
  The snapshot is now recorded by commit sha and resolved to its current position
  immediately before the pop.
- **Cleanup claimed "working tree restored" without checking.** `resetHard` and `checkout`
  return booleans that were discarded, so a reset blocked by a stale `index.lock`, or a
  checkout refused because the branch is open in another worktree, was announced as a
  successful restore. Each step now reports what actually happened, and failures name the
  branch you are still on and where your work is.
- **Failing after the stash was taken orphaned the whole working tree.** Early returns
  between the stash and step 9 left the try block without running cleanup, so the user's
  uncommitted work vanished while the final message named an unrelated cause.
- **SIGHUP was not handled.** Closing a terminal tab or dropping an SSH session left the
  user on the phantom branch with a live stash, an orphaned `claude` process, and no
  output at all. Recovery now listens for it as `watcher.js` always has, and exits 129.
- **A conflicted stash pop was reported as a retryable failure.** git has already written
  the merge and kept the entry, so "run `git stash pop`" could not work. Conflicts are now
  named as conflicts, with the markers and the drop command called out.
- **`Authorization:` headers were published, not redacted.** `auth` is one of the
  sensitive key names, so the generic `KEY=value` rule matched first and treated the
  *scheme* as the secret — `Authorization: [REDACTED] sk0pq7Rt...` — scrubbing the one
  part that was never sensitive. The dedicated header rule below it was unreachable.
- **The crashed command's argv was never redacted.** `node server.js --api-key=...` went
  verbatim into the prompt sent to the model, the post-mortem, the crash JSON, the desktop
  notification and the webhook POST — the one destination that leaves the machine. `redact`
  would have caught it; it was simply never called. The raw argv is still kept for
  reproduction.
- Credentials in URL query strings (`?api_key=`, `?access_token=`) and underscore-form
  tokens (`sk_live_...`) are now redacted, and a quoted multi-word secret is redacted
  whole instead of losing only its first word.
- **`phantom-status` and the guard hook called `process.exit()` after writing.** Pipe
  writes finish asynchronously on Windows, so the status segment could vanish and a guard
  denial could arrive with an empty reason. Both now set `process.exitCode`; a structural
  test enforces the rule across every executable that writes to stdout or stderr.
- **A first run without a Claude Code login reported nothing at all.** The error string is
  built as `'' + '\n' + stderr`, and phantom took line 0 — the empty string — so the user
  saw "claude ended with an error:" followed by nothing, watched the test suite run three
  times, and was then told the session made no changes. Claude's actual message
  ("Please run /login") was on the next line.

## [0.3.5] - 2026-08-22

### Fixed

- The guard's fallback matcher had no `{a,b}` alternation, so `neverTouch: ["*.{pem,key}"]`
  went entirely unenforced whenever the fallback was live.
- On Windows the guard hook was never registered — its command line used POSIX
  `VAR=value` prefix syntax, which cmd.exe cannot parse — so `Bash(cat *)` reached `.env`
  unguarded on one of the three supported platforms. The payload now travels in a file.
- The plugin's `UserPromptSubmit` hook wrote to a pipe and then called `process.exit(0)`,
  truncating anything past ~64 KiB to invalid JSON *after* advancing the read cursor, so
  crash events were lost permanently.
- `describeEvent` threw on a non-coercible command, leaving the cursor unadvanced and
  every later prompt in that repo failing identically.
- `reproTimeoutMs` was read from the wrong object, hard-wiring the timeout to 30 s — one
  test was 30.3 s of a 45 s suite and green by accident.
- A failed commit blamed `--no-commit` even when `autoCommit` was on.
- Raw output is now stripped of terminal escapes before parsing and redaction.

## [0.3.4] - 2026-08-21

### Fixed

- **The Claude Code plugin never loaded.** `plugin.json` declared
  `"hooks": "./hooks/hooks.json"`, but Claude Code loads that path by convention, so the
  manifest registered it a second time and the whole plugin failed with "Duplicate hooks
  file detected". `/plugin install` reported success; only the `/plugin` error tab showed
  it. Broken since the plugin was written and shipped in every release, because nothing in
  the suite read the manifests. `test/plugin-manifest.test.js` now validates both of them:
  no re-declaration of conventional paths, every referenced directory and hook script
  exists, the marketplace entry resolves to the plugin, and the versions track
  `package.json`.

## [0.3.3] - 2026-08-21

### Fixed

- `--notify` produced nothing at all on macOS 15.6, with no way to tell. A
  `display notification` from a command-line process is discarded: nothing appears,
  `osascript` exits 0, and the script never registers under System Settings →
  Notifications -- so there is no permission to grant, and phantom cannot observe the
  difference between delivered and dropped. It now warns once per run when it is on that
  path and points at `brew install terminal-notifier`, which ships its own bundle and does
  deliver. The README previously said to allow Script Editor; that entry never appears, so
  the advice was wrong.

### Changed

- A crash with nothing to go on is now declined instead of recovered. `phantom node -e
  "process.exit(7)"` spent 90 seconds and ~300k tokens to conclude nothing: no error line,
  no stack trace, no file named in the output and no test command, so the session could
  neither locate the fault nor tell whether it had fixed it. That is the shape of a linter
  or build tool exiting non-zero, and spending a session to reliably achieve nothing is
  worse than saying so. A project with a test command still gets a recovery -- the suite is
  both the map and the proof -- and `--dry-run` still runs, since a diagnosis without
  verification is exactly what that mode is for.

### Fixed

- **Phantom could report a fix that fixed nothing.** Verification ran the test command and
  nothing else, so a session that changed no code at all -- or changed code without
  touching the crashing path -- was announced as `✅ fixed · fix verified by phantom` while
  the original command still crashed with the identical error. The tests that "verified" it
  were the ones already passing while the command was dying, since the bug lived in a path
  they never covered. Found by running phantom against a real crash, not by the suite.

  Two changes. A session that changes nothing can no longer be `fixed`, whatever the suite
  says. And after the tests pass, phantom re-runs the command that crashed: exit 0, or
  still running at the 30 s cap, is the evidence; the same failure again is `unfixed` with
  the exit code named. The still-running case is deliberate -- `phantom npm run dev`
  crashed on boot, and surviving past the point it used to die is exactly the proof wanted,
  while waiting for an exit would hang the recovery forever.

  The post-mortem's verification table gains a `Crashed command re-run` row, so the
  distinction between "tests pass" and "the crash is gone" is visible rather than implied.
  Set `"verifyCommand": false` to skip the re-run if the command has side effects you do
  not want repeated.

- **A false alarm on the most alarming message phantom has.** The stat-snapshot audit flags
  any never-touch file that changed on disk, and phantom reported "phantom cannot restore
  these; inspect them now" for a tracked `.env` that the hard reset put back a second
  later. It now checks whether git tracks the file: only a file git never knew about -- a
  gitignored `.env` is the usual one -- is genuinely beyond recovery. A tracked one is
  still a violation and still reverts the branch, but is reported as restored, because it
  was.

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

[Unreleased]: https://github.com/waazy-w/claude-phantom/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/waazy-w/claude-phantom/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/waazy-w/claude-phantom/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/waazy-w/claude-phantom/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/waazy-w/claude-phantom/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/waazy-w/claude-phantom/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/waazy-w/claude-phantom/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/waazy-w/claude-phantom/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/waazy-w/claude-phantom/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/waazy-w/claude-phantom/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/waazy-w/claude-phantom/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/waazy-w/claude-phantom/releases/tag/v0.1.0
