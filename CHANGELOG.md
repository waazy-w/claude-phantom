# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-08-22

Quality-of-life work, from four investigation teams and six implementation agents. The
investigation found 11 bugs alongside the features, several of them mine from earlier the
same day.

### Added

- **Live session progress.** A recovery ran up to fifteen minutes showing one spinner
  line. Phantom already knew what the session was doing and discarded it: the guard hook
  is a `PreToolUse` hook on every file and Bash tool. It now records a redacted, clipped
  trail and the spinner repaints from its tail — `1/3 · editing src/math.js · 2m 07s`.
  Falls back to the plain clock wherever the trail is absent.
- **`v` and `a` at the end-of-run prompt.** The old `[m/d/k]` did not include the one
  thing a person wants at that moment: to look at the diff. `v` shows it and asks again;
  `a` applies the fix to your working tree staged and uncommitted, so you commit it as
  your own rather than taking phantom's commit and message.
- **Repeat-crash detection** (`src/history.js`). The same bug crashing three times used to
  buy three sessions, three branches and three bills — which is the normal shape of a dev
  loop, because the fix is sitting on an unmerged branch. Suppression is self-clearing by
  design: it holds only while an unmerged fix branch for that exact error still exists.
  A prior attempt that *failed* is never suppressed; its report is handed to the next one.
- **Next-step lines on every non-`fixed` banner.** An unfixed run ended with three
  attempts, tens of thousands of tokens and nothing to type, while `phantom recover` sat
  undiscovered. Each outcome now offers the knob that matches why it stopped: more clock
  for a timeout, more attempts for unfixed, the ceiling for a budget stop.
- **`phantom ls --json`**, and piped output that keeps everything the terminal had to
  shorten.
- **A `FileChanged` hook**, so a finished fix appears mid-turn rather than on your next
  one. Verified against the installed Claude Code binary's own schemas.
- A terminal bell after a run longer than 30 s (`PHANTOM_BELL=0` to disable), and a
  heartbeat line for non-TTY runs, where the log previously held zero bytes for fifteen
  minutes and could not be told apart from a hang.

### Changed

- **Inside a Claude Code tool call, phantom captures instead of recovering.** The Bash
  tool times out at 120 s by default (600 s max) and a recovery is allowed 15, so the
  outer call was killed mid-recovery every time — and it was an outer session paying for
  an inner one against the same limit while the outer sat blocked. `--nested-recover`
  overrides.
- **`phantom ls` writes to stdout**, not stderr. It was unreachable from a pipe: the
  piped view existed but the default stream meant `phantom ls | grep` got empty output.
  Anyone using `phantom ls 2>&1 | …` should drop the redirect.
- An unspecified `--limit` now means unlimited when piped; a 10-row cap is the same silent
  loss as truncation.
- The recovery session's hard rules moved to `--append-system-prompt`, so they cannot be
  lost to compaction mid-recovery, and are re-applied on every resume.

### Security

- **The recovery session inherited the parent session's IPC handles.** `buildClaudeEnv`
  stripped two variables; Claude Code exports ten, and `CLAUDE_CODE_MESSAGING_SOCKET` and
  `CLAUDE_CODE_MESSAGING_TOKEN` are a unix socket and bearer token addressed at the user's
  *live session*. A recovery agent denied `WebFetch`, `curl`, `git push` and `Task` was
  inheriting a channel back into the session that launched it. Now stripped by prefix, so
  a variable added later is excluded by default. `CLAUDE_EFFORT` went too — it silently
  set the recovery's reasoning effort from whatever the outer session was using.
- **`/phantom:recover` granted `Bash(git *)`.** Slash-command frontmatter has no deny
  list, so the allow list *is* the boundary — it auto-approved `git push`, `reset --hard`,
  `clean`, `checkout` and `commit`, every item in the skill's own hard rules.
- **`--strict-mcp-config`** is now passed: a target repo's `.mcp.json` servers were being
  spawned by the recovery session, and `--setting-sources project,local` does not drop
  user-scoped ones.

### Fixed

- **The crash event was never closed on any early-exit path**, so `phantom-status` showed
  "fixing …" for twenty minutes after a run phantom had *refused*, and the plugin briefed
  Claude to find a branch that was never created. With `--notify` you waited for a closing
  ping that could not come.
- **The crash capture was written below the dirty-tree and missing-claude checks**, so
  `phantom recover` could not do the two things its own help text promised. After a
  dirty-tree refusal there was no `.phantom/` at all.
- **The event log recorded no base**, so the plugin told Claude to run
  `git diff <base>..<branch>` and Claude guessed `main` — wrong on any feature branch.
- **`ui.wrap()` inserted newlines inside copyable commands and drew boxes wider than the
  terminal.** Below 77 columns a `git diff` command was split across two physical lines;
  below 72 the border itself wrapped into garbage.
- **The spinner never clipped to the terminal width**, so at ≤48 columns every repaint
  left the previous row behind as smear.
- The plugin pointed at a post-mortem template it did not ship, so every interactive
  recovery wrote its report from memory and drifted from the headless one.
- `phantom doctor` no longer orphans a shim (`mise`, `asdf`, `volta`, `npx`) whose child
  outlives its probe.

### Notes

497 → 531 tests. Three of six implementation agents died to API errors mid-write; their
work was completed and tested by hand.

Adding the nested-capture rule exposed that the test suite normally runs *from* Claude
Code, so `CLAUDECODE` is set and the whole CLI test file was about to exercise the nested
branch by accident. Every recovery-path test now declares which side of that it is on.
Behaviour that depends on the terminal the suite was started from is exactly the class of
bug this project keeps finding.

## [0.6.1] - 2026-08-22

Three event-log findings from the original audit that were never actually fixed — I
reported the audit closed while these were still open.

### Fixed

- **A torn last line swallowed the next event.** `appendFileSync` concatenates onto
  whatever is already there, so a log whose final line lost its newline — a writer killed
  mid-write, a full disk — merged the next event into the broken one and left *both*
  unparseable. The crash simply never reached Claude or the status line, and the log did
  not self-heal until the next trim. The tail is checked and healed before appending now.
- **One unreadable line replayed every event the user had already seen.** The cursor was a
  bare event id, and `findIndex` returning `-1` was treated identically to "never
  acknowledged anything" — so if the cursor's own line became unparseable while its
  neighbours survived, the entire retained log came back as unread: a 200-event briefing
  in the next prompt and `(+199)` on the status line. Measured at 39 already-seen events
  replayed. The cursor records its timestamp now, so a missing id degrades to "newer than
  the acknowledged time". The old single-field format is still understood.
- The plugin's copy of the reader was updated to match. It ships without `src/` on disk,
  so the two implementations have to agree on the cursor format or the plugin replays
  everything.

### Documentation

- **The "not a sandbox" caveat says what actually happened.** It described the guard as
  lexical without conveying what that costs: an audit found four ways past it in a single
  afternoon. All four are fixed and pinned by tests, but a lexical guard is a speed bump
  and a fifth way probably exists — the README says so now, and points at the backstops
  that do not depend on parsing a command correctly.

### Known limitation

- **One cursor per repository.** With two Claude Code windows open on the same repo,
  whichever prompts first consumes the crash notification and the other never sees it. A
  per-session cursor would need matching state in the plugin's own copy of the reader and
  a pruning story for abandoned sessions; it is recorded here rather than half-built.

## [0.6.0] - 2026-08-22

Four new subcommands, an environment-variable config layer, and a spend ceiling — built
by four agents working in parallel, then attacked by a security team and a debugging team
before any of it shipped. Those two teams found 14 problems in code that already passed
446 tests, including one that let a repository run arbitrary commands on your machine.

### Added

- **`phantom doctor`** — one preflight for everything a recovery needs: that `claude` is
  installed *and logged in*, that this is a git repository with at least one commit, what
  test command phantom would run, whether desktop notifications can actually reach you,
  and whether the status line and plugin are wired. Not being logged in is the commonest
  first-run failure and used to surface mid-recovery as a blank error line.
- **`phantom ls`** — this repo's fix branches, crash captures and post-mortems.
- **`phantom clean`** — prunes them. Merged branches only by default; an unmerged fix
  branch needs `--unmerged`. Merged deletions go through `git branch -d`, so git re-checks
  at deletion time and a stale plan fails loudly instead of destroying work.
- **`phantom recover`** — replays a crash phantom already captured, for retrying a
  recovery that was refused because the tree was dirty or `claude` was missing. The
  plugin has had `/phantom:recover` since 0.3.0; the CLI made you crash the app again.
- **Environment-variable configuration** — fourteen `PHANTOM_*` variables, sitting between
  the flags and the config files. A flag is this invocation, an env var is this shell or
  CI job, a file is the repository's default. The FAQ recommended a CI recipe that
  previously required committing a `.phantomrc`.
- **`--config <path>`**, **`--webhook <url>`**, and **negatable booleans** — `--commit`,
  `--prompt`, `--no-notify`, `--verify`. Booleans are tri-state internally now: "not
  mentioned" has to be distinguishable from "explicitly off", or a config file that turned
  something on could never be overridden without editing it.
- **`maxTokens` / `maxCostUsd`** — a real spend ceiling. `maxIterations` and `maxMinutes`
  bound how often phantom asks and how long it waits; neither bounds what it spends. The
  dollar figure is an estimate from published rates, hedged as one, and phantom never
  volunteers an amount unless you configured a ceiling. An unknown model prices as the
  most expensive one known, because a ceiling that guesses low is passed unnoticed.

### Security

- **A planted crash capture could run arbitrary commands.** A crash JSON used to be a file
  phantom only ever *wrote*; `phantom recover` makes it one phantom *reads*, and a
  repository can ship one. `ctx.testCommand` was returned verbatim by
  `resolveTestCommand` and executed by `runTests` with `shell: true` — and was never even
  type-checked. Clone a repo, hit a crash, run `phantom recover`, and their shell ran.
  The test command recorded in a capture is now discarded outright: phantom resolves it
  locally, so a saved file does not get to choose what executes.
- **`git.root` must be absolute.** A relative `"."` resolved against the working
  directory, so it satisfied the wrong-repo check from *any* repository the user happened
  to be standing in — defeating the one guard meant to stop a capture from one checkout
  being replayed into another.
- **`phantom clean` could delete outside the repository.** The "inside `.phantom/`"
  boundary was computed lexically, and `unlink` follows symlinks, so a repo shipping
  `.phantom/reports -> ../outside` produced entries that passed the check while the
  deletion resolved through the link. Containment is now anchored on the real repository
  root as well as the real directory.
- **`--config` on a non-JSON file echoed its first bytes**, because Node embeds them in
  its parse error. It reports the position now.

### Fixed

- **The stash-restore hint could point at the wrong stash.** `git stash` parses a numeric
  argument as a stack *index*, and a 10-character sha abbreviation is all digits about 1%
  of the time — so `git stash apply 2358190719` silently applied `stash@{0}` instead of
  phantom's entry, which is exactly the data loss the by-sha mechanism was added to
  prevent in 0.3.6. Shas are printed in full now, and the copyable command is printed
  outside the banner box, because the box wraps on spaces and split it in half.
- **`phantom recover --help` started a real recovery.** The subcommand parsed `--help` and
  then never looked at it, so asking for help stashed, branched, patched and spent. Help
  and `--version` are answered for every subcommand before anything is loaded or spawned.
- **`PHANTOM_DISABLED=1` did not stop `phantom recover`** — the check lived behind a
  `config` the CLI always supplied, so the documented kill switch was unreachable from the
  command line for the one subcommand that spends money.
- **A subcommand after phantom's flags was silently misrouted**: `phantom --verbose ls`
  ran `/bin/ls`, `phantom --dry-run recover` died with "command not found". Both are now
  named as the mistake they are, with the `phantom -- ls` escape hatch pointed at.
- **The budget stop counted an attempt that never ran**, so the banner said "stopped after
  2 attempt(s)" beside a token total from one.
- **A single-segment `reportDir` made `clean` silently unable to delete crash captures** —
  with `reportDir: "reports"` the captures live in a *sibling* directory, which the
  first-path-segment boundary rejected while reporting success.
- **Two crashes in the same second overwrote each other.** The 1-second timestamp named
  both the capture and the report, so the second run replaced the first's capture and
  *appended* to its report, producing one post-mortem with two verification blocks.
- **A `.phantomrc` at the git root beat a `package.json` "phantom" field in the directory
  you ran from**, contradicting the documented "nearest first, first hit wins".
- `phantom recover` usage errors exit 2 like every other usage error, not 1 — a script can
  tell "you typed it wrong" from "the replay did not fix it".
- `phantom doctor` rejects unknown options instead of ignoring every argument, and no
  longer orphans a shim (`mise`, `asdf`, `volta`, `npx`) whose child outlives its probe.

## [0.5.0] - 2026-08-22

Closes the rest of the audit: the guard bypasses, the resource leaks, and every
documentation claim that was not true.

### Security

- **Commands that read everything without naming anything are refused.** The path
  checks are lexical — they can only refuse a path that appears in the command line —
  so `grep -rs . .`, `git log -p`, `git show HEAD:.env`, `find . -exec cat {} +` and
  `tar cf - . | base64` read every file in the repo while naming none, and
  `Bash(grep *)`, `Bash(git log *)` and `Bash(git show *)` are all on the allowlist. In
  a sandbox repo `grep -rs . .` printed the AWS key and `git log -p` printed it out of
  history. The check is scope-aware rather than a flat ban: a recursive search is
  refused only when the directory it would walk actually holds never-touch files, and
  `git log -p` only when the repo actually tracks one, so `grep -rn TODO src` still works.
- **A redirect without a space defeated the tokenizer.** `<` and `>` were not split
  characters, so `cat<.env`, `cat 0<.env` and `echo pwned>.env` produced one token that
  matched no glob and no path. The spaced forms were caught all along, which is what made
  the gap easy to miss; the write form destroyed a gitignored `.env` outright.
- **Bash could read outside the repository.** `checkFile` hard-denied an escaping path
  from the first release, but `checkBash` only glob-tested them — so `cat /etc/passwd`,
  `cat ~/.ssh/id_rsa` and `cat ~/.aws/credentials` were allowed through the one tool that
  can ignore the prompt's "work only inside the repository". `~` never resolved either.
- **Bracket globs matched nothing, in either direction.** `expandGlob` compiled them with
  the never-touch matcher, which escapes `[` and `]`, so `.[e]nv` matched neither the file
  on disk nor the `.env` rule — the guard allowed it and the shell then expanded it.
  Expansion now follows shell rules; never-touch rules keep theirs.
- **`reportDir` is validated.** It is interpolated into the guard hook's command line on
  Windows, where arguments are quoted but not escaped, so a `.phantomrc` reading
  `.phantom/reports" & calc & "` ran `calc` on every `PreToolUse` hook. It was checked
  only as "a non-empty string"; it must now be a relative path with no shell
  metacharacters and no `..`.

### Fixed

- **Ring-buffer memory was driven by the number of writes, not their size.** Every write
  became its own Buffer and the index array grew to twice the live chunk count before
  compacting, so an unbuffered child cost ~130 bytes of heap per retained byte — 30 MB of
  heap and 255 MB of RSS for a 256 KB tail. Small writes are now coalesced into blocks:
  the same workload costs 0.3 bytes per byte. A retained oversized chunk is also copied
  rather than kept as a `subarray` view, which used to pin the whole original allocation.
- **The output tail could start mid-character.** Eviction cuts on a byte boundary, so
  decoding produced U+FFFD at the head of the tail for any non-ASCII output, and that
  flowed into the crash JSON, the prompt and the report.
- **Every successful `phantom npm run dev` recovery orphaned a process tree.** `spawnSync`'s
  `timeout` signals the direct child only — npm, not the server it started — which kept
  running and kept its port, so the user's next real `npm run dev` failed with EADDRINUSE
  with nothing pointing at phantom. It is the documented *success* path: "still running
  counts as fixed" means the timeout fires every time a long-lived command is repaired.
- **`git clean -fd` destroyed untracked work.** Phantom tells the user their branch is
  untouched, which invites them to keep working, and there is one working tree — so a file
  created during a run looked exactly like one the session created, and Ctrl+C deleted it
  with no reflog to recover from. Untracked files are now rescued into a stash first, and
  phantom prints the command that brings them back.
- **The status line claimed to be fixing crashes phantom had refused.** `announceCrash`
  ran before the refusal check, so a declined crash still logged an event — and since no
  recovery event follows, the status line showed "fixing …" for twenty minutes and the
  plugin briefed Claude to look for a fix branch that was never created.
- **Reports were written non-atomically**, so a reader could catch a half-written file and
  a Ctrl+C inside the write destroyed the post-mortem. Written and renamed now.
- **Banner borders were misaligned** wherever an emoji appeared — which is every status
  line phantom prints — because width was measured in UTF-16 code units rather than
  terminal columns.
- **Every run printed its outcome twice**: the banner, then the identical sentence again.
- The headless session and both verification runs now spawn with `windowsHide`, so a
  Windows recovery no longer flashes console windows.

### Added

- **`keepReports` (default 50).** Nothing pruned `.phantom/crashes/` or `.phantom/reports/`,
  and each crash JSON carries the full context up to `ringBufferBytes`. The newest are
  kept; `0` keeps everything.
- **A `pack-smoke` CI job** on all three platforms, pinned to Node **18.0.0** rather than
  the floating `18` that resolves to 18.20.x. It packs the tarball, installs it into a
  path with a space and a non-ASCII character, asserts every runtime file dependency
  resolves from what `files` actually shipped, and runs phantom inside a git worktree.
  Those are the classes the existing matrix structurally cannot catch — and they are
  exactly how `plugin/` went missing from the tarball for four releases.

### Documentation

Every claim below was false, stale, or unverifiable against the code:

- **"the redacted last 256 KiB of output"** — the session sees the last 200 lines capped
  at **24 KiB**. 256 KiB is what phantom *retains*. Off by ~10× on the central promise.
- **The example banner and post-mortem were fabricated** — wrong header, wrong row order,
  `merge`/`discard` instead of `accept`/`reject`, and a three-column table phantom has
  never emitted, all labelled "from `examples/crash-demo`". Replaced with real output.
- The README contradicted itself on the macOS notification permission; `.phantomrc` is
  read from the working directory first and not merged; `--max-turns` is a third hard cap
  nothing mentioned; exit codes 126, 127, 129 and 143 were missing; the allow and deny
  tables were both incomplete while reading as exhaustive.
- The site advertised a Windows guard hole that 0.3.5 closed, and printed a `.phantomrc`
  panel that omitted `verifyCommand` and showed `testCommand` at a default it does not have.

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

[Unreleased]: https://github.com/waazy-w/claude-phantom/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/waazy-w/claude-phantom/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/waazy-w/claude-phantom/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/waazy-w/claude-phantom/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/waazy-w/claude-phantom/compare/v0.4.0...v0.5.0
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
