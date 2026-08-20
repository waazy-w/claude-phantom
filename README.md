<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/phantom-mark-dark.svg">
    <img src="brand/phantom-mark.svg" alt="" width="112">
  </picture>
</p>

# claude-phantom
An autonomous crash-recovery agent for your terminal. Run your app through `phantom`; if it crashes, a headless Claude Code session diagnoses the bug, writes a failing test, patches it on a separate branch, verifies the fix independently, and leaves a post-mortem. Your branch is never touched.
```sh
npm install -g claude-phantom
phantom npm run dev
```

[![npm version](https://img.shields.io/npm/v/claude-phantom.svg)](https://www.npmjs.com/package/claude-phantom)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

<!--
  Demo GIF: produce docs/demo.gif with `PHANTOM_REPO="$PWD" vhs docs/demo.tape`
  (see "Recording the demo GIF" below). Until it exists this image is a broken link.
-->
![phantom demo](docs/demo.gif)

## How it works

While your command runs, phantom is invisible: stdout and stderr stream through byte-for-byte, stdin is passed through, and the exit code is preserved. It keeps only the last 256 KiB of output in a ring buffer. When the process exits non-zero or dies from a signal (other than your own Ctrl+C), recovery starts.

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

Nothing in this flow trusts the agent's own word. The verification step runs your test command from phantom, not from inside the Claude session, and the never-touch audit diffs the branch against the starting commit after the session ends.

## Safety rails

Each rail below names the mechanism, not just the promise.

| Rail | Mechanism |
|---|---|
| Never your branch | `git checkout -b phantom/fix-<slug>-<ts>` from `HEAD` before any edit. Phantom checks your original branch back out when it finishes, succeeds or fails. The fix exists only as a branch you can diff, merge, or delete. |
| Minimal tools | The headless session runs with `--permission-mode dontAsk` and an explicit allowlist: `Read, Edit, Write, MultiEdit, Grep, Glob`, your test command, `Bash(npm test *)`, `Bash(npm run test *)`, `Bash(npx vitest|jest|mocha *)`, `Bash(node *)`, and read-only git (`git diff`, `git log`, `git status`, `git show`) plus `ls`, `cat`, `head`, `tail`, `grep`, `pwd`. Every other tool call is denied without prompting. (Claude Code itself auto-approves read-only shell commands in headless mode; that is its policy, not something phantom can tighten.) |
| Explicit denies on top | `WebFetch`, `WebSearch`, `Task`, `Agent`, `NotebookEdit`, `Bash(git push *)`, `Bash(git checkout *)`, `Bash(git switch *)`, `Bash(git reset *)`, `Bash(git stash *)`, `Bash(git rebase *)`, `Bash(git commit *)`, `Bash(git clean *)`, `Bash(rm *)`, `Bash(curl *)`, `Bash(wget *)`, `Bash(npm install *)`, `Bash(npm i *)`, `Bash(npm ci *)`, `Bash(npx prisma *)`, `Bash(sudo *)` are passed as `--disallowedTools`. Denies win over allows. |
| Guard hook | A `PreToolUse` hook (`src/guard-hook.js`, zero dependencies, fails closed) inspects every `Bash`, `Edit`, `Write`, `Read`, `Grep` and `Glob` call before it runs. It blocks never-touch paths (including via `cat`, redirects, `../` traversal and absolute paths), destructive shell (`rm -r`, `chmod -R`, `dd`, `mkfs`, `kill`), package installs, network clients, migrations, container/cluster tools, `DROP TABLE`/`TRUNCATE`, and every git command that changes state. In dry-run it also blocks every write except the report file. |
| Never-touch files, enforced three times | Globs from `neverTouch` (default: `.env`, `.env.*`, `**/*.pem`, `**/*.key`, `**/secrets/**`, `**/*.secret*`) plus the fixed `.git/**` and `node_modules/**` are (1) written as `Read`/`Edit`/`Write`/`MultiEdit`/`Grep`/`Glob` permission deny rules for the session, (2) checked by the guard hook on every tool call, and (3) audited after the session: `git diff --name-only <baseSha>` plus untracked files, *and* a size/mtime/inode snapshot of every never-touch file taken before the session (so a gitignored `.env` is covered too; contents are never read). Any match discards the session's changes (`git reset --hard && git clean -fd`) and the report says why. Files git does not track cannot be restored by phantom; the banner tells you to inspect them. |
| No pushes, no PRs, ever | `git push` is on the deny list, there is no network tool, and phantom itself has no push code path. Not configurable. |
| Ctrl+C is a kill switch | At any point during recovery: kills the Claude process tree, `git reset --hard` on the fix branch, `git clean -fd` there, checks out your original branch, pops the snapshot stash if one was taken, exits 130. One idempotent cleanup handler. |
| Dirty tree refused | Uncommitted changes → status `refused`, nothing happens, your exit code is preserved. `--allow-dirty` stashes a snapshot (`git stash push -u -m "phantom-snapshot-<ts>"`) first, and pops it back automatically once you are back on your branch (also on Ctrl+C). If phantom has to leave you on the fix branch (`--no-commit`), it prints the exact `git stash pop` to run. `--dry-run` never needs a clean tree because it never writes outside `.phantom/`. |
| Hard caps | `maxIterations` (default 3) bounds Claude invocations; `maxMinutes` (default 15) is a wall-clock timer that kills the child. Neither is advisory. |
| Dry-run mode | `--dry-run`: `Edit`/`MultiEdit` are removed from the allowlist and the guard hook rejects every `Write` except the report file. No branch, no edits. The diagnosis and proposed unified diff go into the report. The only writes are under `.phantom/`. |
| Off switch | `PHANTOM_DISABLED=1` turns phantom into a pure passthrough. |

| What phantom can see | What phantom can never do |
|---|---|
| Your repo's tracked and untracked source files, minus never-touch globs | Read, edit, or create a never-touch file through any tool call |
| The last 256 KiB of your command's output, redacted | Push, open a PR, or use a network tool (`WebFetch`, `curl`, `wget`, …) |
| `git log`, `git status`, `git diff` | Switch, reset, stash, or commit branches — phantom owns git |
| `package.json` name and scripts | Install packages, run `npx`/`npm exec`, or run migrations |
| The output of your test command | `rm -r`, `sudo`, `chmod -R`, `kill`, `docker`, `kubectl` |
| Your environment variables (the session inherits your shell's env, like any CLI) | Commit to your branch |

What it is **not**: a sandbox. The session may run `node` (it has to, to run your tests), and a `node -e` one-liner can in principle read any file your user can read or open a socket. The guard is lexical; the branch isolation, the post-session audit, and the fact that nothing is ever pushed are the real backstops. If you need hard isolation, run phantom inside a container.

A note on the output tail: before the last 256 KiB of output is handed to the session, phantom runs it through a best-effort redactor (`KEY=value` pairs with secret-looking names, `Authorization` headers, `sk-`/`ghp_`/`AKIA`/`xox`-style tokens, JWTs, URL credentials, PEM blocks → `[REDACTED]`). It is a safety net, not a guarantee: if your app prints secrets at startup, fix that first.

## Prerequisites

- Node >= 18
- git (phantom refuses to recover outside a git repository)
- Claude Code CLI, installed and authenticated:

  ```sh
  npm install -g @anthropic-ai/claude-code
  claude   # follow the login prompt once
  ```

Recovery runs `claude -p` under your account. It uses your Claude subscription or API billing, exactly as an interactive session would.

## What you get back

Every recovery writes a markdown post-mortem to `.phantom/reports/`. This is a trimmed example from running `phantom npm start` in `examples/crash-demo`:

```markdown
# Post-mortem: TypeError: Cannot read properties of undefined (reading 'email')

Status: ✅ FIXED    Branch: phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
Command: npm start  Exit: 1  Duration: 0.4s  Captured: 2026-08-20T18:41:07Z

## Root cause
`formatOrderLine` in `src/report.js:9` dereferences `order.customer.email`
unconditionally. `data/orders.json` contains a guest checkout (`ord_1003`)
with no `customer` object, so the report builder throws on boot before the
HTTP server starts listening.

## Blast radius
- `buildReport` is called on startup and on every HTTP request, so any
  guest order in the data set takes the whole service down, not just one line.
- Existing tests only cover orders with a customer; the gap was untested.

## Fix
    --- a/src/report.js
    +++ b/src/report.js
    @@ -8,3 +8,3 @@ function formatOrderLine(order) {
    -  const email = order.customer.email;
    +  const email = order.customer?.email ?? '(guest)';
       const total = orderTotal(order).toFixed(2);

Regression test added: `test/report.test.js` → "formatOrderLine tolerates a
guest order with no customer".

## Verification (independent)
| Step | Command | Result |
|---|---|---|
| Reproduce (new test, pre-fix) | npm test | ❌ 1 failed, 4 passed |
| Verify (post-fix) | npm test | ✅ 5 passed |
| Original command | npm start | ✅ exit 0 (server listening) |

Iterations: 1/3  Wall clock: 1m 48s  Never-touch audit: clean
Review: git diff main..phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
```

The `## Verification (independent)` section and the metadata line are written by phantom, not by the session. If the session produces no report at all, phantom writes a fallback one with the crash context and whatever the session said.

## Usage

```
phantom [flags] [--] <command> [args...]
```

The `--` is optional; the first token that is not a phantom flag starts your command.

| Flag | Effect |
|---|---|
| `--dry-run` | Diagnose and propose a diff without creating a branch or editing files. |
| `--allow-dirty` | Proceed with uncommitted changes after taking a stash snapshot. |
| `--test <cmd>` | Test command for verification (overrides config and `package.json`). |
| `--max-iterations <n>` | Cap on Claude invocations in the fix/verify loop (default 3). |
| `--max-minutes <n>` | Wall-clock cap for the whole recovery (default 15). |
| `--model <m>` | Passed through as `claude --model <m>`. |
| `--no-commit` | Leave the fix uncommitted on the phantom branch. Phantom then stays on that branch (checking yours out would carry the changes over) and prints the way back. |
| `--notify` | Desktop notification when a crash is detected and when recovery ends. See [Claude Code integration](#claude-code-integration). |
| `--verbose` | Stream the session's progress lines in dim text. |
| `--version` | Print the version and exit. |
| `--help` | Print usage and exit. |

Environment: `PHANTOM_DISABLED=1` disables recovery entirely (pure passthrough).

**Exit codes.** Phantom always exits with your command's exit code. A clean exit is exit 0; a crash that phantom fixed is still exit 1 (or whatever your app returned). Phantom never masks a failure, so it is safe inside scripts and `&&` chains. If the command died from a signal, phantom exits `128 + signal number`, the same as a shell (`SIGSEGV` → 139, `SIGKILL` → 137). If you interrupt a recovery with Ctrl+C, phantom exits 130.

## Configuration

Phantom reads `.phantomrc` (JSON) from the git root, or a `"phantom"` key in `package.json`. CLI flags override both.

**Precedence:** CLI flags > `.phantomrc` > `package.json` `"phantom"` key > defaults.

Full `.phantomrc` with every key at its default:

```jsonc
{
  "testCommand": "npm test",
  "maxIterations": 3,
  "maxMinutes": 15,
  "neverTouch": [".env", ".env.*", "**/*.pem", "**/*.key", "**/secrets/**", "**/*.secret*"],
  "webhook": null,
  "notify": false,
  "model": null,
  "autoCommit": true,
  "reportDir": ".phantom/reports",
  "ringBufferBytes": 262144,
  "claudeBin": "claude"
}
```

| Key | Default | Meaning |
|---|---|---|
| `testCommand` | `"npm test"` if `package.json` has a `test` script, else `null` | Command phantom runs to verify the fix. With `null`, phantom still patches but cannot verify; the report says so. |
| `maxIterations` | `3` | Hard cap on Claude invocations (initial + resumes). |
| `maxMinutes` | `15` | Hard wall-clock cap for the whole recovery. |
| `neverTouch` | see above | Globs the session may not read, edit, or create. `.git/**` and `node_modules/**` are always added and cannot be removed. |
| `webhook` | `null` | URL to `POST` a JSON summary (status, branch, report path) on completion. Best-effort, 5 s timeout. |
| `notify` | `false` | Desktop notification on crash and when recovery ends (same as `--notify`). |
| `model` | `null` | Model name passed to `claude --model`. |
| `autoCommit` | `true` | Commit a successful fix on the phantom branch. Never commits on yours. |
| `reportDir` | `".phantom/reports"` | Where post-mortems go. Crash captures go to the sibling `crashes/` directory. |
| `ringBufferBytes` | `262144` | Bytes of recent output kept for the crash context. |
| `claudeBin` | `"claude"` | Claude Code executable. |

The same keys work under `"phantom"` in `package.json`:

```json
{
  "scripts": { "start": "node src/server.js", "test": "node --test" },
  "phantom": { "maxMinutes": 10, "neverTouch": [".env", "config/prod/**"] }
}
```

Setting `neverTouch` replaces the default list rather than extending it, so repeat any defaults you still want. `.git/**` and `node_modules/**` are always added and cannot be removed.

## Reviewing a fix

Phantom leaves you on your original branch with a banner like:

```
phantom: ✅ FIXED on phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
  report   .phantom/reports/20260820-184107-typeerror-cannot-read-properties-of-undefined.md
  review   git diff main..phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
  merge    git merge phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
  discard  git branch -D phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
```

Read the report, read the diff, run the tests yourself, then merge or delete. Treat the branch like a PR from a fast contributor who has never seen your codebase before: usually right about the symptom, worth a second look on the shape of the fix.

Reports and crash captures live under `.phantom/`, which is gitignored by default. Commit them if you want a history.

## Claude Code integration

Phantom runs in its own terminal, but you are probably chatting with Claude Code in another one. Three things connect them; each is optional and takes about a minute.

| Integration | What you see | Setup |
|---|---|---|
| Plugin hooks | At the start of your next message in Claude Code: *👻 phantom: `npm run dev` crashed 3m ago — fixed on `phantom/fix-…`* | Install the plugin (below). |
| Status line | A 👻 segment in Claude Code's status bar: `👻 fixing npm run dev…` → `👻 fixed npm run dev → phantom/fix-…` | Point `statusLine` at `phantom-status` (below). |
| Desktop notification | A macOS/Linux notification the moment a crash is detected, and again when recovery ends | `phantom --notify …` or `"notify": true` in `.phantomrc`. |

All three read the same file: `.phantom/events.jsonl`, which phantom appends to whenever it detects a crash or finishes a recovery. It lives in your repo root, is kept out of git via `.git/info/exclude` (never your `.gitignore`), is capped at 200 lines, and events older than 24 hours are ignored. Nothing is sent anywhere.

### 1. Plugin: crash reports in your chat

The repository doubles as a Claude Code plugin (`plugin/`). Inside Claude Code:

```
/plugin marketplace add waazy-w/claude-phantom
/plugin install phantom@claude-phantom
```

Or, without the marketplace, from a checkout or an install:

```sh
claude --plugin-dir ./plugin
claude --plugin-dir node_modules/claude-phantom/plugin
```

The plugin provides:

- **Hooks** (`UserPromptSubmit`, `SessionStart`) — before Claude sees your message, a tiny script checks `.phantom/events.jsonl` for events you have not been told about. If there are any, Claude is given a short briefing and asked to mention it in one or two lines, offer `git diff` / `git merge` for the fix branch and to open the report, and then carry on with whatever you asked. Each event is reported once. When there is nothing new the hook prints nothing and costs one file `stat`.
- `/phantom:recover` — run the same recovery procedure interactively inside Claude Code, with you approving each step.
- `crash-recovery` skill — the operating procedure itself (diagnose → failing test → minimal patch → verify → post-mortem). This file is the single source of truth; the headless prompt is generated from it.

Check it is active with `/hooks` in Claude Code: you should see `phantom-events.js` under both events.

Claude Code cannot be interrupted from outside, so the message appears on your *next* turn, not the instant the crash happens. For instant notice use the status line or a desktop notification.

### 2. Status line: a 👻 that stays until you have seen it

`phantom-status` (installed alongside `phantom`) prints one short line for Claude Code's status bar, or nothing when there is nothing to show:

| State | Segment |
|---|---|
| Crash detected, recovery running | `👻 fixing npm run dev…` |
| Recovery fixed it | `👻 fixed npm run dev → phantom/fix-20260820-1432-customer` |
| Recovery could not fix it | `👻 could not fix npm run dev` |
| Dry run finished | `👻 dry run: npm run dev` |
| Crashed, no recovery for 20+ min | `👻 npm run dev crashed 25m ago` |

Several unread events show as `(+N)`. The segment clears when the plugin hook reports the events in your chat, or when you run `phantom-status --mark-read`.

**If you have no status line yet**, add this to `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "phantom-status" }
}
```

**If you already have one**, keep it and append phantom's segment. Copy [`examples/statusline.sh`](examples/statusline.sh) somewhere (say `~/.claude/statusline.sh`), set `BASE` inside it to your current status-line command, and point `statusLine.command` at the script. It reads Claude Code's JSON once and feeds it to both commands, so neither loses its input.

The status line refreshes whenever Claude Code redraws (after each message, tool call, or permission prompt), so a crash that happens while you are reading will show up on the next redraw rather than instantly.

### 3. Desktop notification: the instant it happens

```sh
phantom --notify npm run dev          # once
echo '{ "notify": true }' > .phantomrc   # always, for this repo
```

You get one notification when the crash is detected (*👻 phantom: crash detected — `npm run dev` — TypeError: … — phantom is taking over*) and one when recovery ends (*👻 phantom: fixed — branch phantom/fix-…*).

- **macOS** uses the built-in `osascript`; no setup. Those notifications carry the Script Editor icon because Apple does not let a script choose its own. To get the phantom logo instead, install [terminal-notifier](https://github.com/julienXX/terminal-notifier):

  ```sh
  brew install terminal-notifier
  ```

  Phantom detects it on `PATH` and uses it automatically, with the phantom icon. The first notification may ask you to allow notifications from terminal-notifier in System Settings → Notifications.
- **Linux** uses `notify-send` (package `libnotify-bin` on Debian/Ubuntu, `libnotify` on Fedora/Arch) with the phantom icon.
- **Windows** is not supported yet; `--notify` is silently ignored there.

Notifications are best-effort and time out after 4 seconds; they never delay or fail a recovery.

## Recording the demo GIF

`npm run demo` copies `examples/crash-demo` into a temporary git repository and runs `phantom npm start` inside it. The app crashes on a guest order with no `customer`; phantom recovers it in one or two iterations.

With [VHS](https://github.com/charmbracelet/vhs), a ready tape is included:

```sh
npm link                              # `phantom` on PATH from this checkout
PHANTOM_REPO="$PWD" vhs docs/demo.tape
```

The tape sets up the temp repo in a hidden block, types `phantom npm start`, waits ~90 s for recovery, then shows `cat .phantom/reports/*.md | head -40`. Real recovery time varies, so adjust the `Sleep 90s` line if the GIF cuts off early or idles too long.

With asciinema + agg:

```sh
cd "$(mktemp -d)" && cp -R "$OLDPWD/examples/crash-demo/." . && git init -q && git add -A && git commit -qm init
asciinema rec -c "phantom npm start" demo.cast
agg --speed 3 demo.cast demo.gif
```

Keep the final GIF under ~30 s: cut idle time with tighter `Sleep` values in the tape, use `Set PlaybackSpeed 2.0`, or `agg --speed`. Recovery spawns a real Claude session and bills your account.

## Known limitations

- **Exit-based detection only.** Phantom notices when the process exits. Supervisors that swallow the crash and keep the parent alive (`nodemon`, `pm2`, `forever`, `--watch` modes) are not detected. Run the underlying command instead: `phantom node src/server.js`, not `phantom nodemon src/server.js`.
- **git is required.** No repository, no recovery; phantom still passes the command through.
- **Non-deterministic.** Claude may fail to fix the bug. Phantom then leaves the branch clearly marked unfixed (status `unfixed` or `timeout`), returns you to your branch, and the report documents what it tried and why verification failed.
- **Uses your Claude billing.** Every recovery is a real session.
- **Best on Node/JS projects with a test runner.** The patch step works for any language Claude Code can edit, but verification needs a `testCommand`, and the crash-context heuristics (stack-trace extraction, hint files) are tuned for Node traces first.
- **Windows support is best-effort.** Developed and tested on macOS and Linux. Signal semantics and path matching on Windows are not covered by the test suite yet, and the guard hook is skipped there (shell quoting differs), leaving the permission deny rules and the post-session audit.
- **No sandbox.** The allowlist, deny rules, and guard hook constrain *tool calls*, not what a `node` process can do once allowed. The session also inherits your environment variables. Treat phantom like any other CLI you run with your credentials, and use a container if that is not acceptable.
- **Redaction is pattern-based.** The captured output tail is scrubbed of common secret shapes before it is stored or sent, but an unusual format will get through. Apps that print secrets at startup should stop doing that regardless.
- **Never-touch files outside git cannot be restored.** If a gitignored `.env` changes during a session, phantom detects it (size/mtime/inode snapshot), discards the session's work, and tells you — but it cannot put the old contents back, because it never read them.
- **Your app sees a pipe, not a TTY.** Tools that detect a TTY will drop colors or change output. Set `FORCE_COLOR=1` (or your tool's equivalent) if you want the colors back.
- **Ctrl+C while phantom is running your test command** waits for that test run to finish if the signal is sent only to phantom's PID. A terminal Ctrl+C reaches the test process too, so it ends promptly in practice.
- **A child that keeps stdout open keeps phantom waiting.** A daemonized server that inherits the pipe will hold the wrapper until the pipe closes; run foreground servers.
- **A broken `.phantomrc` fails fast.** Invalid config exits 2 before your command runs, even for commands that would have succeeded.

## FAQ

**Does it ever push?**
No. `git push` is on the deny list, there is no network tool in the session, and phantom itself contains no code that pushes. There is no flag to enable it.

**Can it touch my `.env`?**
No. `.env` and `.env.*` are in the default `neverTouch` list, which is enforced as a permission deny rule during the session and as a diff audit after it. If the audit ever finds a never-touch file changed, the fix branch is hard-reverted and the report says so. Your app's own log output is the one thing to watch: phantom redacts common secret shapes from the captured tail before the session sees it, but the redactor is pattern-based and cannot know every format.

**What if I'm mid-change?**
Phantom refuses to recover on a dirty tree. If you want it anyway, `--allow-dirty` takes a stash snapshot first and prints the `git stash pop` command to restore your work. The snapshot is popped automatically if you Ctrl+C.

**How much does a recovery cost?**
One to three headless Claude Code turns plus test runs, bounded by `maxIterations` and `maxMinutes`. For a small crash like the demo, expect something in the range of a short interactive debugging session. Set `maxIterations: 1` and a cheaper `model` if you want a hard ceiling.

**Can I use it in CI?**
Yes, with `--dry-run`: it writes a diagnosis and proposed diff to `.phantom/reports/` and never creates a branch or edits files, which is what you want from an unattended runner. Upload `.phantom/` as an artifact. Full fix mode also works in CI, but since nothing is pushed the branch vanishes with the runner, so there is little point.

**Does phantom slow my app down?**
No measurable overhead: it is a child-process spawn with piped stdio and a bounded buffer. The 50 MB log-flood case is part of the test suite.

**Can I run it from inside a Claude Code session?**
Yes. Phantom strips the `CLAUDECODE` environment variable before spawning the headless session, so nesting works.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: zero dependencies, tests for behaviour changes, and any change to the allowed-tools list or never-touch defaults needs a written justification.

## License

[MIT](LICENSE) © 2026 saaz
