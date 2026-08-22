<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/phantom-mark-dark.svg">
    <img src="brand/phantom-mark.svg" alt="" width="112">
  </picture>
</p>

# claude-phantom

**[claudephantom.dev](https://claudephantom.dev)**

An autonomous crash-recovery agent for your terminal. Run your app through `phantom`; if it crashes, a headless Claude Code session diagnoses the bug, writes a failing test, patches it on a separate branch, verifies the fix independently, and leaves a post-mortem. Your branch is never touched.

<!-- Demo GIF: produce docs/demo.gif with `PHANTOM_REPO="$PWD" vhs docs/demo.tape` (see "Demo GIF" below). -->

![phantom recovering a crashed Node service: the app throws, phantom opens a fix branch, patches it, runs the tests itself, and writes a post-mortem](docs/demo.gif)

[![ci](https://github.com/waazy-w/claude-phantom/actions/workflows/ci.yml/badge.svg)](https://github.com/waazy-w/claude-phantom/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/claude-phantom.svg)](https://www.npmjs.com/package/claude-phantom)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

## Setup

**You need:** Node >= 18, git (phantom only recovers inside a git repository), and the Claude Code CLI, logged in:

```sh
npm install -g @anthropic-ai/claude-code
claude                         # follow the login prompt once
```

**Install and run:**

```sh
npm install -g claude-phantom
phantom npm run dev            # any command; phantom is invisible until it crashes
```

That is the whole setup. On a crash, phantom creates `phantom/fix-<slug>-<ts>`, fixes it there, verifies, writes `.phantom/reports/<ts>-<slug>.md`, and puts you back on your branch with `git diff` / `git merge` / `git branch -D` commands to review, accept, or discard the fix. In an interactive terminal it then asks whether to merge the branch, delete it, or keep it for later; anywhere else â a pipe, CI, `--no-prompt` â it just prints the commands and exits.

**Optional, one minute each** (details in [Claude Code integration](#claude-code-integration)):

```sh
phantom --notify npm run dev   # desktop notification on crash and when recovery ends
```

```
/plugin marketplace add waazy-w/claude-phantom      # inside Claude Code: crash briefings in your chat
/plugin install phantom@claude-phantom              # then restart Claude Code
```

```json
{ "statusLine": { "type": "command", "command": "phantom-status" } }   // ~/.claude/settings.json: 👻 in the status bar
```

Recovery runs `claude -p` under your account and bills your Claude subscription or API key like any interactive session. `PHANTOM_DISABLED=1` turns phantom into a pure passthrough.

## How it works

Your command runs exactly as before: stdout, stderr, and stdin stream through byte-for-byte, the exit code is preserved, and only the last 256 KiB of output is kept in a ring buffer. Recovery starts when the process exits non-zero or dies from a signal other than your own Ctrl+C.

```
  $ phantom npm start
        |
        v
  +------------------------------+
  | passthrough + 256 KiB ring   |   your app runs exactly as before
  +------------------------------+
        | exit != 0  (or signal)
        v
  +------------------------------+
  | capture: stack trace, tail,  |   -> .phantom/crashes/*.json
  | git state, package.json      |
  +------------------------------+
        |
        v
  +------------------------------+
  | safety checks                |   clean tree? git repo? claude found?
  | git checkout -b phantom/fix- |   (--dry-run: no branch at all)
  +------------------------------+
        |
        v
  +------------------------------+
  | claude -p  (headless)        |   minimal tools, never-touch
  |  1. diagnose                 |   globs denied, no network, no push
  |  2. write failing test       |
  |  3. minimal patch            |
  +------------------------------+
        |
        v
  +------------------------------+   phantom runs your test command
  | independent verification     |<--- itself; on failure, resumes the
  | (max N iterations, T min)    |---> session with the test output
  +------------------------------+
        |
        v
  +------------------------------+
  | never-touch audit, commit on |   -> .phantom/reports/*.md
  | fix branch, post-mortem      |
  +------------------------------+
        |
        v
  back on your original branch, exit code = your app's exit code
```

Nothing here trusts the agent's own word: phantom runs your test command itself, outside the Claude session, and audits the branch against the starting commit after the session ends.

## Safety rails

| Rail | Mechanism |
|---|---|
| Never your branch | `git checkout -b phantom/fix-<slug>-<ts>` from `HEAD` before any edit; your branch is checked back out when phantom finishes, success or failure. The fix exists only as a branch to diff, merge, or delete. |
| Minimal tools | `--permission-mode dontAsk` with an explicit allowlist: `Read, Edit, Write, MultiEdit, Grep, Glob`, your test command, `npm test` / `npm run test <args>` / `npx vitest\|jest\|mocha`, `node`, read-only git (`diff`, `log`, `status`, `show`), and `ls cat head tail grep pwd`. Everything else is denied without prompting. (Claude Code auto-approves read-only shell commands in headless mode; phantom cannot tighten that.) |
| Explicit denies | `--disallowedTools`, abridged: `WebFetch`, `WebSearch`, `Task`, `Agent`, `NotebookEdit`, every state-changing git command (`push`, `checkout`, `switch`, `reset`, `stash`, `rebase`, `commit`, `clean`, `merge`, `branch -D`), `rm`, `rmdir`, `curl`, `wget`, `ssh`, `scp`, package managers (`npm install/i/ci/uninstall`, `yarn add`, `pnpm add`, `pip install`), `npx prisma`, `chmod -R`, `chown`, `docker`, `kubectl`, `pkill`, `killall`, `sudo`. See `DENY` in `src/prompt.js` for the full list. Denies win over allows. |
| Guard hook | A zero-dependency `PreToolUse` hook (`src/guard-hook.js`, fails closed) inspects every `Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob` call: blocks never-touch paths (via `cat`, redirects spaced or not, shell globs, `../`, absolute paths), any path outside the repository (`/etc/passwd`, `~/.ssh/id_rsa`), destructive shell (`rm -r`, `chmod -R`, `dd`, `mkfs`, `kill`), installs, network clients, migrations, container/cluster tools, `DROP TABLE`/`TRUNCATE`, and every state-changing git command. It also refuses **bulk reads** — commands that read many files without naming one: a recursive `grep` over a directory that holds never-touch files, `git show <rev>:<path>` for such a path, `git log -p` in a repo that tracks one, `find -exec`, `tar`, `xargs`, `base64`. In dry-run it blocks every write, Bash redirects and `sed -i` included, except the report. |
| Never-touch files, enforced three times | `neverTouch` globs (default `.env`, `.env.*`, `**/*.pem`, `**/*.key`, `**/secrets/**`, `**/*.secret*`) plus the fixed `.git/**`, `node_modules/**` are (1) permission deny rules for the session, (2) checked by the guard hook on every call, (3) audited afterwards via `git diff --name-only <baseSha>`, untracked files, and a size/mtime/inode snapshot taken before the session (covers gitignored files; contents are never read). Any hit discards the session's changes (`git reset --hard && git clean -fd`) and the report says why — and if that revert does not succeed, phantom says so rather than claiming it did. Untracked files cannot be restored by phantom; the banner tells you to inspect them. |
| No pushes, no PRs | `git push` is denied, there is no network tool, and phantom has no push code path. Not configurable. |
| Ctrl+C is a kill switch | Kills the Claude process tree, rescues any untracked file into a stash first, `git reset --hard` + `git clean -fd` on the fix branch, checks out your branch, restores the snapshot stash if any, exits 130. `SIGTERM` (143) and `SIGHUP` (129) — a closed terminal or a dropped SSH session — do the same. |
| Silent crash declined | A non-zero exit with no error line, no stack trace, no file named in the output *and* no test command is refused: the session would have nothing to locate the fault with and nothing to verify against. Common for linters and build tools. `--dry-run` still runs. |
| Dirty tree refused | Uncommitted changes → status `refused`, nothing happens. `--allow-dirty` stashes a snapshot (`git stash push -u -m "phantom-snapshot-<ts>"`) and pops it back once you are on your branch (also on Ctrl+C); with `--no-commit` it prints the exact `git stash apply <sha>` (by sha, so a stash pushed meanwhile by another shell cannot be popped by mistake). `--dry-run` never needs a clean tree. |
| Hard caps | `maxIterations` (3) bounds Claude invocations; `maxMinutes` (15) is a wall-clock timer that kills the child; each session also carries `--max-turns` (80, or 40 on a resume), so a session that loops without converging is ended by Claude Code itself. |
| Dry run | `--dry-run`: no branch, no edits (`Edit`/`MultiEdit` removed, writes rejected except the report, Bash redirects and `sed -i` refused too). Diagnosis and proposed diff go into the report; the only writes are under `.phantom/`. Because there is no branch to revert, phantom also measures the tree afterwards: anything the session wrote anyway is named, undone file by file, and reported as an error rather than a clean dry run. |
| Isolated session | `--setting-sources project,local`: your user-level `~/.claude/settings.json` (hooks, permission allows, env), your installed plugins, and their MCP servers are not loaded into the recovery session, so nothing personal can rewrite, approve, or observe its commands. Project `.claude/settings.json` still applies; phantom's deny rules and guard hook are passed explicitly via `--settings` and verified to register in this mode. |
| Off switch | `PHANTOM_DISABLED=1` → pure passthrough. |

The session can see your tracked and untracked source (minus never-touch globs), a redacted slice of the crash output (the last 200 lines, capped at 24 KiB — `ringBufferBytes`, 256 KiB by default, is how much phantom *retains*, not how much the session is shown), read-only git history, `package.json` name and scripts, your test output, and — like any CLI — your environment variables. It can never read or write a never-touch file, push, open a PR, use the network, change branches, install packages, run migrations, or commit to your branch.

**Not a sandbox.** The session may run `node` (it has to, to run your tests), and a `node -e` one-liner can in principle read any file your user can read or open a socket. The guard is lexical; branch isolation, the post-session audit, and the no-push rule are the real backstops. Need hard isolation? Run phantom in a container.

**Redaction.** The output tail *and the command line phantom displays* are scrubbed before anything sees them — the model's prompt, the post-mortem, the crash JSON, the desktop notification and the webhook payload (`KEY=value` with secret-looking names, quoted multi-word values, `Authorization` headers, `?api_key=`-style URL query credentials, `sk-`/`sk_`/`ghp_`/`AKIA`/`xox` tokens, JWTs, URL credentials, PEM blocks → `[REDACTED]`). The raw argv is kept only to re-run your command. Pattern-based, so a safety net, not a guarantee.

## What you get back

A banner on your original branch (real output, from `examples/crash-demo`):

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ 👻 phantom ✅ fixed · 1m 48s · 34.1k tokens (12k new · 22.1k cached)          │
│ fix verified by phantom: tests pass and the command no longer crashes; your   │
│ branch is unchanged                                                           │
│                                                                               │
│ branch  phantom/fix-typeerror-cannot-read-properties-k3f9a                    │
│ review  git diff main..phantom/fix-typeerror-cannot-read-properties-k3f9a     │
│ accept  git merge phantom/fix-typeerror-cannot-read-properties-k3f9a          │
│ reject  git branch -D phantom/fix-typeerror-cannot-read-properties-k3f9a      │
│                                                                               │
│ report  .phantom/reports/20260820-184107-typeerror-cannot-read-properties.md  │
│ session 192389b5-e0e9-4c66-a16c-a1a9d4f1cd4b  (claude --resume 192389b5-…)    │
╰──────────────────────────────────────────────────────────────────────────────╯
```

And a markdown post-mortem in `.phantom/reports/`. The `TL;DR` and the analysis
below it come from the session; everything in the verification table is measured
by phantom (trimmed):

```markdown
# 👻 Phantom post-mortem — TypeError: Cannot read properties of undefined (reading 'email')

> **Status:** ✅ FIXED

| | |
|---|---|
| **Iterations** | 1 |
| **Duration** | 1m 48s |
| **Model / tokens** | 34.1k tokens (12k new · 22.1k cached) |

## TL;DR

`formatOrderLine` dereferenced `order.customer.email` unconditionally, and
`data/orders.json` has a guest checkout with no `customer`. Optional chaining
with a `(guest)` fallback; regression test added.

## Verification (independent)

| Check | Result |
|---|---|
| Tests run by phantom | ✅ passed — `npm test` |
| Crashed command re-run | ✅ exits 0 — `npm start` |
| Files changed | `src/report.js`, `test/report.test.js` |
| Never-touch audit | ✅ clean |
| Branch | `phantom/fix-typeerror-cannot-read-properties-k3f9a` from `main` @ `a1b2c3d4e5` |
| Iterations used | 1 |
| Wall clock | 1m 48s |
| Session | `192389b5-…` — transcript in `~/.claude/projects/`, reopen with `claude --resume 192389b5-…` |
```

The verification section and metadata are written by phantom, not the session. The session id points at Claude Code's full transcript of the recovery (every tool call and file read) under `~/.claude/projects/`; `claude --resume <id>` reopens it so you can ask the session what it did. If the session produces no report, phantom writes a fallback with the crash context and whatever the session said. Treat the branch like a PR from a fast contributor who has never seen your codebase: read the report and the diff, run the tests yourself, then merge or delete. `.phantom/` is kept out of git via `.git/info/exclude`; commit it if you want a history.

## Usage

```
phantom [flags] [--] <command> [args...]
phantom doctor | ls | clean | recover [flags]
```

Flags go before the command; everything after the command is passed through verbatim (`phantom npm run dev --verbose` gives `--verbose` to npm). `--` is optional.

### Subcommands

| Command | What it does |
|---|---|
| `phantom doctor` | Checks everything a recovery needs **before** your first crash: that `claude` is installed *and logged in*, that this is a git repo with at least one commit, what test command phantom would run, whether desktop notifications can actually reach you, and whether the status line and plugin are wired. Exits non-zero only on a real failure. |
| `phantom ls` | This repo's phantom history: `phantom/fix-*` branches (merged or not, age, subject), crash captures, and post-mortems. |
| `phantom clean` | Prunes them. Merged branches only by default — an unmerged fix branch is never deleted without `--unmerged`. `--older-than <days>`, `--all`, `--dry-run`, `--yes`. Merged branches go via `git branch -d`, so git re-checks at deletion time and a stale plan fails instead of destroying work. |
| `phantom recover` | Replays a crash phantom already captured, without waiting for it to happen again — for retrying a recovery that was refused because the tree was dirty or `claude` was missing. Uses the newest capture unless you name one. `--list`, `--force`. |

`phantom -- ls -la` still wraps the real `ls`; the separator is the escape hatch.

| Flag | Effect |
|---|---|
| `--dry-run` | Diagnose and propose a diff; no branch, no edits. |
| `--allow-dirty` | Proceed with uncommitted changes after taking a stash snapshot. |
| `--test <cmd>` | Verification command (overrides config and `package.json`). |
| `--max-iterations <n>` | Cap on Claude invocations (default 3, max 10). |
| `--max-minutes <n>` | Wall-clock cap for the recovery (default 15, max 120). |
| `--model <m>` | Passed through as `claude --model <m>`. |
| `--no-commit` | Leave the fix uncommitted on the phantom branch; phantom stays on it and prints the way back. |
| `--no-prompt` | Never ask whether to merge or delete the fix branch; just print the commands. |
| `--notify` | Desktop notification on crash and when recovery ends. On macOS this needs `terminal-notifier` (`brew install terminal-notifier`); without it the AppleScript fallback is silently swallowed by Notification Center — see [Desktop notification](#claude-code-integration). |
| `--webhook <url>` | POST a JSON summary when recovery ends. |
| `--config <path>` | Use this config file instead of searching for one. A missing file is an error, not a silent fallback. |
| `--verbose` | Stream the session's progress lines. |
| `--version`, `--help` | |

**Every boolean flag negates**, so a setting in your config file can be turned off for a single run: `--commit`, `--prompt`, `--no-notify`, `--verify`. This is why they are tri-state internally — "not mentioned" has to be distinguishable from "explicitly off", or a `.phantomrc` that turned something on could never be overridden without editing the file.

**Environment.** `PHANTOM_DISABLED=1` makes phantom a pure passthrough. Settings can also come from the environment, which sits between the flags and the config files — a flag is this invocation, an env var is this shell or this CI job, a file is the repository's default:

`PHANTOM_TEST`, `PHANTOM_MODEL`, `PHANTOM_MAX_ITERATIONS`, `PHANTOM_MAX_MINUTES`, `PHANTOM_MAX_TOKENS`, `PHANTOM_MAX_COST_USD`, `PHANTOM_WEBHOOK`, `PHANTOM_CLAUDE_BIN`, `PHANTOM_REPORT_DIR`, `PHANTOM_KEEP_REPORTS`, `PHANTOM_NOTIFY`, `PHANTOM_AUTO_COMMIT`, `PHANTOM_PROMPT_ON_FINISH`, `PHANTOM_VERIFY_COMMAND`.

Values are coerced and validated, and an unparseable one is an error rather than a silent default — `PHANTOM_NOTIFY=maybe` quietly meaning "off" is exactly the misconfiguration that wastes an afternoon.

**Exit codes.** Always your command's exit code — a fixed crash is still exit 1, so phantom is safe in scripts and `&&` chains. Signal deaths exit `128 + signal` like a shell (`SIGSEGV` → 139). A command that cannot be found exits 127 and one that cannot be spawned exits 126, matching a shell. During recovery, Ctrl+C exits 130, `SIGTERM` exits 143 and `SIGHUP` exits 129. Invalid flags or config exit 2 before your command runs.

## Configuration

`.phantomrc` (JSON), or a `"phantom"` key in `package.json`. Precedence: flags > `.phantomrc` > `package.json` > defaults.

Both files are looked for in the directory you ran from **first**, then at the git root, and the first hit wins — so a `.phantomrc` in a subdirectory silently overrides the one at the root rather than merging with it. Every key at its default:

```jsonc
{
  "testCommand": "npm test",      // auto: "npm test" if package.json has a test script, else null (patch but cannot verify)
  "maxIterations": 3,             // hard cap on Claude invocations (initial + resumes)
  "maxMinutes": 15,               // hard wall-clock cap
  "neverTouch": [".env", ".env.*", "**/*.pem", "**/*.key", "**/secrets/**", "**/*.secret*"],
                                  // replaces the default list (repeat what you keep); .git/** and node_modules/** are always added
  "webhook": null,                // POST a JSON summary (status, branch, report) on completion; best-effort, 5 s timeout
  "notify": false,                // same as --notify
  "model": null,                  // claude --model
  "autoCommit": true,             // commit a successful fix on the phantom branch (never on yours)
  "promptOnFinish": true,         // after a verified fix, ask whether to merge or delete the branch (TTY only)
  "verifyCommand": true,          // after the tests pass, re-run the command that crashed (30 s cap; still running = fixed)
  "reportDir": ".phantom/reports",// relative to the repo, no shell metacharacters; crash captures go to the sibling crashes/
  "ringBufferBytes": 262144,      // output phantom retains for crash context (the session sees the last 200 lines of it, capped at 24 KiB)
  "keepReports": 50,              // crash JSONs and post-mortems kept per repo; 0 keeps everything
  "maxTokens": null,              // hard token ceiling for one recovery; null = no ceiling
  "maxCostUsd": null,             // estimated-USD ceiling for one recovery; null = no ceiling
  "claudeBin": "claude"           // Claude Code executable
}
```

```json
{ "phantom": { "maxMinutes": 10, "neverTouch": [".env", "config/prod/**"] } }
```

## Claude Code integration

Phantom runs in its own terminal while you chat with Claude Code in another. Three optional bridges, all reading `.phantom/events.jsonl` (appended on every crash and recovery outcome, git-excluded, capped at 200 lines, events older than 24 h ignored, nothing sent anywhere):

| Bridge | What you see | When |
|---|---|---|
| Plugin hooks | Claude opens your next reply with *👻 phantom: `npm run dev` crashed 3m ago — fixed on `phantom/fix-…`*, offers `git diff`/`git merge` and the report, then continues with your request | Your next message |
| Status line | `👻 fixing npm run dev…` → `👻 fixed npm run dev → phantom/fix-…` in Claude Code's status bar until seen | Next redraw (each message, tool call, prompt) |
| Desktop notification | *👻 phantom: crash detected — npm run dev — TypeError …*, then *👻 phantom: fixed — branch …* | Instantly |

Claude Code cannot be interrupted from outside, so the chat message is always on your next turn; use the status line or a notification for instant notice.

**Plugin.** Inside Claude Code, `/plugin marketplace add waazy-w/claude-phantom` then `/plugin install phantom@claude-phantom`, and restart — or `claude --plugin-dir ./plugin` (or `node_modules/claude-phantom/plugin`) with no install at all. Nothing gatekeeps this: `marketplace add` clones this repository and reads [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) from `main`. The plugin also stands alone — without the CLI you lose the automatic takeover and the hooks stay quiet (they read files only `phantom` writes), but `/phantom:recover` still runs the whole procedure on a crash you paste in. It ships the `UserPromptSubmit`/`SessionStart` hooks (each event reported once; silent and one `stat` when nothing is new — confirm with `/hooks`), `/phantom:recover` for interactive recovery with you approving each step, and the `crash-recovery` skill, which is the single source of truth the headless prompt is generated from.

**Status line.** `phantom-status` (installed with `phantom`) prints one line or nothing. States: `👻 fixing <cmd>…` (crash < 20 min, recovery running), `👻 fixed <cmd> → <branch>`, `👻 could not fix <cmd>`, `👻 dry run: <cmd>`, `👻 <cmd> crashed 25m ago` (no recovery after 20 min); `(+N)` for several unread. It clears when the hook reports the events or after `phantom-status --mark-read`. No status line yet: `"statusLine": { "type": "command", "command": "phantom-status" }` in `~/.claude/settings.json`. Already have one: copy [`examples/statusline.sh`](examples/statusline.sh), set `BASE` to your current command, point `statusLine.command` at the script — it replays Claude Code's stdin JSON to both.

**Desktop notification.** `phantom --notify …` or `"notify": true`.

**On macOS, install `terminal-notifier` or expect nothing to appear.**

```sh
brew install terminal-notifier
```

Phantom uses it automatically once present, with the phantom icon. Without it, phantom falls back to built-in `osascript`, and on macOS 14+ a `display notification` from a command-line process is discarded: nothing appears, `osascript` exits 0, and the script never registers under System Settings → Notifications, so there is no permission to grant and nothing phantom can detect. Verified on 15.6. Phantom warns once per run when it is on that path, because silence is otherwise indistinguishable from working.

Linux uses `notify-send` (`libnotify-bin` / `libnotify`) with the icon. Windows: silently ignored. Best-effort, 4 s timeout, never delays a recovery.

## Updating

The CLI and the plugin are released together and always carry the same version, but they update through different channels.

```sh
npm view claude-phantom version   # what the latest release is
npm update -g claude-phantom      # the CLI
```

```sh
claude plugin marketplace update claude-phantom   # refresh the listing
claude plugin update phantom@claude-phantom       # then restart Claude Code to apply
```

Both also work from the `/plugin` menu inside Claude Code, which shows what is installed and what is available.

**Neither channel announces anything, so subscribe once:** on [the repository](https://github.com/waazy-w/claude-phantom), *Watch → Custom → Releases*. GitHub then emails you once per version, which covers both halves, and [every release](https://github.com/waazy-w/claude-phantom/releases) carries notes. There is no telemetry and phantom never checks for a newer version behind your back — it makes no network calls at all.

One thing to know about the plugin: `marketplace add` tracks this repository's `main`, not the npm release, so `claude plugin update` gives you whatever is currently on the default branch. That is usually a good thing — a fix reaches you before it is published — but it is not a pinned version.

## Demo GIF

`npm run demo` copies `examples/crash-demo` into a temp git repo and runs `phantom npm start`; the app crashes on a guest order and phantom recovers it in one or two iterations. It is a real Claude Code session (~90 s), so it consumes your plan's usage allowance — or API credit if `ANTHROPIC_API_KEY` is set. To re-record the demo: `npm link && PHANTOM_REPO="$PWD" vhs docs/demo.tape` writes an MP4 master, then `node docs/make-demo-gif.js` renders `docs/demo.gif` from it (compressing only the stretch where Claude is working, so the GIF stays ~25 s). Rendering is free and repeatable; only the recording costs usage.

## Known limitations

- **Exit-based detection only.** Supervisors that swallow the crash (`nodemon`, `pm2`, `forever`, `--watch`) are not detected; wrap the underlying command: `phantom node src/server.js`.
- **git required.** Outside a repo phantom only passes the command through.
- **Non-deterministic.** Claude may fail; the branch is then marked `unfixed`/`timeout`, you are back on your branch, and the report says what was tried and why verification failed.
- **Uses your Claude billing** for every recovery.
- **Best on Node/JS with a test runner.** Patching works for anything Claude Code can edit, but verification needs a `testCommand` and the crash heuristics are tuned for Node traces first.
- **Windows runs the full suite in CI**, alongside macOS and Linux, on Node 18/20/22/24. Six tests are skipped there because Windows cannot express them: libuv maps SIGTERM/SIGINT/SIGKILL onto an unconditional `TerminateProcess`, so a killed child never reports a signal and a target's own handler cannot run. One real difference remains: phantom wraps programs, not shell lines, so `phantom dir` and other `cmd` built-ins do not work — the same as on POSIX. (Through 0.3.4 the guard hook was also skipped on Windows, because its command carried the guard's config in a POSIX `VAR=value` prefix that `cmd.exe` cannot parse. The deny rules that remained cover the file tools but not `Bash`, so `cat .env` was unguarded on Windows alone. The config now travels in a file and the hook reads it from argv, so every platform runs the same guard.)
- **No sandbox** (see above) and the session inherits your environment variables.
- **Redaction is pattern-based**; unusual secret formats get through.
- **Never-touch files outside git cannot be restored** — phantom detects the change, discards the session's work, and tells you, but never read the old contents.
- **Your app sees a pipe, not a TTY**; set `FORCE_COLOR=1` (or equivalent) to keep colours.
- **Ctrl+C during the test run** waits for it if the signal reaches only phantom's PID; a terminal Ctrl+C reaches the test too.
- **A child that keeps stdout open keeps phantom waiting** — run foreground servers, not daemons.
- **A broken `.phantomrc` exits 2 before your command runs.**

## FAQ

**Does it ever push?** No — denied tool, no network tool, no push code path, no flag.

**Can it touch my `.env`?** No: `.env`/`.env.*` are never-touch by default, enforced as deny rules, by the guard hook, and by the post-session audit that hard-reverts the branch on any hit. Watch your own log output: the redactor is pattern-based.

**I'm mid-change.** Phantom refuses on a dirty tree; `--allow-dirty` stashes a snapshot first and restores it automatically (also on Ctrl+C).

**How much does it cost?** One to three headless turns plus test runs; roughly a short interactive debugging session. `maxIterations` and `maxMinutes` bound how often phantom asks and how long it waits, but neither bounds *spend* — one iteration on a large repo can cost more than three on a small one. For an actual ceiling set `maxTokens` or `maxCostUsd`: phantom then checks before each additional attempt and stops rather than starting one it cannot afford. It never blocks the first attempt, since with nothing spent every ceiling is affordable.

The dollar figure is an **estimate** from published API rates, not your bill — phantom cannot see your account, and a subscription is not priced per token. When the model is unknown (the default, since Claude Code picks) it prices as the most expensive model it knows, because a ceiling that guesses low gets passed unnoticed. Phantom never volunteers a dollar amount unless you configured a ceiling.

**Before the first crash, run `phantom doctor`.** It checks `claude` is installed *and logged in* — not being logged in is the commonest first-run failure, and it used to surface mid-recovery as a blank error line.

**CI?** Use `--dry-run`: diagnosis and proposed diff in `.phantom/reports/`, no branch, no edits; upload `.phantom/` as an artifact. Full mode works but the branch dies with the runner since nothing is pushed.

**Overhead?** None measurable — a child-process spawn with piped stdio and a bounded buffer (a 50 MB log flood is in the test suite).

**From inside Claude Code?** Yes; phantom strips `CLAUDECODE` from the environment before spawning the headless session, so nesting works.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): zero dependencies, tests for behaviour changes, and a written justification for any change to the allowed-tools list or never-touch defaults.

## License

[MIT](LICENSE) © 2026 saaz
