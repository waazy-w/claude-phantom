<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/phantom-mark-dark.svg">
    <img src="brand/phantom-mark.svg" alt="" width="112">
  </picture>
</p>

# claude-phantom

An autonomous crash-recovery agent for your terminal. Run your app through `phantom`; if it crashes, a headless Claude Code session diagnoses the bug, writes a failing test, patches it on a separate branch, verifies the fix independently, and leaves a post-mortem. Your branch is never touched.

[![npm version](https://img.shields.io/npm/v/claude-phantom.svg)](https://www.npmjs.com/package/claude-phantom)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

<!-- Demo GIF: produce docs/demo.gif with `PHANTOM_REPO="$PWD" vhs docs/demo.tape` (see "Demo GIF" below). -->
![phantom demo](docs/demo.gif)

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

That is the whole setup. On a crash, phantom creates `phantom/fix-<slug>-<ts>`, fixes it there, verifies, writes `.phantom/reports/<ts>-<slug>.md`, and puts you back on your branch with `git diff` / `git merge` / `git branch -D` commands to review, accept, or discard the fix.

**Optional, one minute each** (details in [Claude Code integration](#claude-code-integration)):

```sh
phantom --notify npm run dev   # desktop notification on crash and when recovery ends
```

```
/plugin marketplace add waazy-w/claude-phantom      # inside Claude Code: crash briefings in your chat
/plugin install phantom@claude-phantom
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
| Minimal tools | `--permission-mode dontAsk` with an explicit allowlist: `Read, Edit, Write, MultiEdit, Grep, Glob`, your test command, `npm test` / `npm run test` / `npx vitest\|jest\|mocha`, `node`, read-only git (`diff`, `log`, `status`, `show`), and `ls cat head tail grep pwd`. Everything else is denied without prompting. (Claude Code auto-approves read-only shell commands in headless mode; phantom cannot tighten that.) |
| Explicit denies | `--disallowedTools`: `WebFetch`, `WebSearch`, `Task`, `Agent`, `NotebookEdit`, `git push/checkout/switch/reset/stash/rebase/commit/clean`, `rm`, `curl`, `wget`, `npm install/i/ci`, `npx prisma`, `sudo`. Denies win over allows. |
| Guard hook | A zero-dependency `PreToolUse` hook (`src/guard-hook.js`, fails closed) inspects every `Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob` call: blocks never-touch paths (including via `cat`, redirects, `../`, absolute paths), destructive shell (`rm -r`, `chmod -R`, `dd`, `mkfs`, `kill`), installs, network clients, migrations, container/cluster tools, `DROP TABLE`/`TRUNCATE`, and every state-changing git command. In dry-run it blocks every write except the report. |
| Never-touch files, enforced three times | `neverTouch` globs (default `.env`, `.env.*`, `**/*.pem`, `**/*.key`, `**/secrets/**`, `**/*.secret*`) plus the fixed `.git/**`, `node_modules/**` are (1) permission deny rules for the session, (2) checked by the guard hook on every call, (3) audited afterwards via `git diff --name-only <baseSha>`, untracked files, and a size/mtime/inode snapshot taken before the session (covers gitignored files; contents are never read). Any hit discards the session's changes (`git reset --hard && git clean -fd`) and the report says why. Untracked files cannot be restored by phantom; the banner tells you to inspect them. |
| No pushes, no PRs | `git push` is denied, there is no network tool, and phantom has no push code path. Not configurable. |
| Ctrl+C is a kill switch | Kills the Claude process tree, `git reset --hard` + `git clean -fd` on the fix branch, checks out your branch, pops the snapshot stash if any, exits 130. |
| Dirty tree refused | Uncommitted changes → status `refused`, nothing happens. `--allow-dirty` stashes a snapshot (`git stash push -u -m "phantom-snapshot-<ts>"`) and pops it back once you are on your branch (also on Ctrl+C); with `--no-commit` it prints the exact `git stash pop`. `--dry-run` never needs a clean tree. |
| Hard caps | `maxIterations` (3) bounds Claude invocations; `maxMinutes` (15) is a wall-clock timer that kills the child. |
| Dry run | `--dry-run`: no branch, no edits (`Edit`/`MultiEdit` removed, writes rejected except the report). Diagnosis and proposed diff go into the report; the only writes are under `.phantom/`. |
| Isolated settings | The session starts with `--setting-sources project,local`: your user-level `~/.claude/settings.json` (hooks, permission allows, env) is not loaded, so a global hook cannot rewrite or approve commands inside the recovery. Project `.claude/settings.json` still applies; phantom's own deny rules and guard hook are passed explicitly. |
| Off switch | `PHANTOM_DISABLED=1` → pure passthrough. |

The session can see your tracked and untracked source (minus never-touch globs), the redacted last 256 KiB of output, read-only git history, `package.json` name and scripts, your test output, and — like any CLI — your environment variables. It can never read or write a never-touch file, push, open a PR, use the network, change branches, install packages, run migrations, or commit to your branch.

**Not a sandbox.** The session may run `node` (it has to, to run your tests), and a `node -e` one-liner can in principle read any file your user can read or open a socket. The guard is lexical; branch isolation, the post-session audit, and the no-push rule are the real backstops. Need hard isolation? Run phantom in a container.

**Redaction.** The output tail is scrubbed before the session sees it (`KEY=value` with secret-looking names, `Authorization` headers, `sk-`/`ghp_`/`AKIA`/`xox` tokens, JWTs, URL credentials, PEM blocks → `[REDACTED]`). Pattern-based, so a safety net, not a guarantee.

## What you get back

A banner on your original branch:

```
phantom: ✅ FIXED on phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
  report   .phantom/reports/20260820-184107-typeerror-cannot-read-properties-of-undefined.md
  review   git diff main..phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
  merge    git merge phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
  discard  git branch -D phantom/fix-typeerror-cannot-read-properties-of-undefined-k3f9a2
  session  192389b5-e0e9-4c66-a16c-a1a9d4f1cd4b  (claude --resume 192389b5-e0e9-4c66-a16c-a1a9d4f1cd4b)
```

And a markdown post-mortem in `.phantom/reports/` (trimmed, from `examples/crash-demo`):

```markdown
# Post-mortem: TypeError: Cannot read properties of undefined (reading 'email')
Status: ✅ FIXED    Branch: phantom/fix-typeerror-…-k3f9a2    Command: npm start  Exit: 1
Session: 192389b5-… — transcript in ~/.claude/projects/, reopen with `claude --resume 192389b5-…`

## Root cause
`formatOrderLine` in `src/report.js:9` dereferences `order.customer.email`
unconditionally; `data/orders.json` has a guest checkout with no `customer`.

## Blast radius
`buildReport` runs on startup and on every request, so one guest order takes
the whole service down. Existing tests only covered orders with a customer.

## Fix
    -  const email = order.customer.email;
    +  const email = order.customer?.email ?? '(guest)';
Regression test added: test/report.test.js → "formatOrderLine tolerates a guest order".

## Verification (independent)
| Step                          | Command   | Result                 |
| Reproduce (new test, pre-fix) | npm test  | ❌ 1 failed, 4 passed   |
| Verify (post-fix)             | npm test  | ✅ 5 passed             |
| Original command              | npm start | ✅ exit 0               |
Iterations: 1/3  Wall clock: 1m 48s  Never-touch audit: clean
```

The verification section and metadata are written by phantom, not the session. The session id points at Claude Code's full transcript of the recovery (every tool call and file read) under `~/.claude/projects/`; `claude --resume <id>` reopens it so you can ask the session what it did. If the session produces no report, phantom writes a fallback with the crash context and whatever the session said. Treat the branch like a PR from a fast contributor who has never seen your codebase: read the report and the diff, run the tests yourself, then merge or delete. `.phantom/` is kept out of git via `.git/info/exclude`; commit it if you want a history.

## Usage

```
phantom [flags] [--] <command> [args...]
```

Flags go before the command; everything after the command is passed through verbatim (`phantom npm run dev --verbose` gives `--verbose` to npm). `--` is optional.

| Flag | Effect |
|---|---|
| `--dry-run` | Diagnose and propose a diff; no branch, no edits. |
| `--allow-dirty` | Proceed with uncommitted changes after taking a stash snapshot. |
| `--test <cmd>` | Verification command (overrides config and `package.json`). |
| `--max-iterations <n>` | Cap on Claude invocations (default 3, max 10). |
| `--max-minutes <n>` | Wall-clock cap for the recovery (default 15, max 120). |
| `--model <m>` | Passed through as `claude --model <m>`. |
| `--no-commit` | Leave the fix uncommitted on the phantom branch; phantom stays on it and prints the way back. |
| `--notify` | Desktop notification on crash and when recovery ends. |
| `--verbose` | Stream the session's progress lines. |
| `--version`, `--help` | |

**Exit codes.** Always your command's exit code — a fixed crash is still exit 1, so phantom is safe in scripts and `&&` chains. Signal deaths exit `128 + signal` like a shell (`SIGSEGV` → 139); Ctrl+C during recovery exits 130; invalid flags or config exit 2 before your command runs.

## Configuration

`.phantomrc` (JSON) at the git root, or a `"phantom"` key in `package.json`. Precedence: flags > `.phantomrc` > `package.json` > defaults. Every key at its default:

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
  "reportDir": ".phantom/reports",// crash captures go to the sibling crashes/
  "ringBufferBytes": 262144,      // output kept for crash context
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

**Plugin.** Inside Claude Code, `/plugin marketplace add waazy-w/claude-phantom` then `/plugin install phantom@claude-phantom` — or `claude --plugin-dir ./plugin` (or `node_modules/claude-phantom/plugin`). It ships the `UserPromptSubmit`/`SessionStart` hooks (each event reported once; silent and one `stat` when nothing is new — confirm with `/hooks`), `/phantom:recover` for interactive recovery with you approving each step, and the `crash-recovery` skill, which is the single source of truth the headless prompt is generated from.

**Status line.** `phantom-status` (installed with `phantom`) prints one line or nothing. States: `👻 fixing <cmd>…` (crash < 20 min, recovery running), `👻 fixed <cmd> → <branch>`, `👻 could not fix <cmd>`, `👻 dry run: <cmd>`, `👻 <cmd> crashed 25m ago` (no recovery after 20 min); `(+N)` for several unread. It clears when the hook reports the events or after `phantom-status --mark-read`. No status line yet: `"statusLine": { "type": "command", "command": "phantom-status" }` in `~/.claude/settings.json`. Already have one: copy [`examples/statusline.sh`](examples/statusline.sh), set `BASE` to your current command, point `statusLine.command` at the script — it replays Claude Code's stdin JSON to both.

**Desktop notification.** `phantom --notify …` or `"notify": true`. macOS uses built-in `osascript` (Script Editor icon, since Apple does not let scripts pick their own); `brew install terminal-notifier` and phantom switches to it automatically with the phantom icon (allow it once in System Settings → Notifications). Linux uses `notify-send` (`libnotify-bin` / `libnotify`) with the icon. Windows: silently ignored. Best-effort, 4 s timeout, never delays a recovery.

## Demo GIF

`npm run demo` copies `examples/crash-demo` into a temp git repo and runs `phantom npm start`; the app crashes on a guest order and phantom recovers it in one or two iterations (a real, billed session, ~90 s). Record it with [VHS](https://github.com/charmbracelet/vhs): `npm link && PHANTOM_REPO="$PWD" vhs docs/demo.tape` (adjust the tape's `Sleep 90s` to the real recovery time), or with asciinema: `asciinema rec -c "phantom npm start" demo.cast && agg --speed 3 demo.cast demo.gif` from a copy of the demo. Keep it under ~30 s.

## Known limitations

- **Exit-based detection only.** Supervisors that swallow the crash (`nodemon`, `pm2`, `forever`, `--watch`) are not detected; wrap the underlying command: `phantom node src/server.js`.
- **git required.** Outside a repo phantom only passes the command through.
- **Non-deterministic.** Claude may fail; the branch is then marked `unfixed`/`timeout`, you are back on your branch, and the report says what was tried and why verification failed.
- **Uses your Claude billing** for every recovery.
- **Best on Node/JS with a test runner.** Patching works for anything Claude Code can edit, but verification needs a `testCommand` and the crash heuristics are tuned for Node traces first.
- **Windows is best-effort.** Developed and tested on macOS and Linux; signal semantics and path matching are untested there, and the guard hook is skipped (shell quoting differs), leaving deny rules and the audit.
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

**How much does it cost?** One to three headless turns plus test runs, bounded by `maxIterations` and `maxMinutes`; roughly a short interactive debugging session. `maxIterations: 1` and a cheaper `model` give a hard ceiling.

**CI?** Use `--dry-run`: diagnosis and proposed diff in `.phantom/reports/`, no branch, no edits; upload `.phantom/` as an artifact. Full mode works but the branch dies with the runner since nothing is pushed.

**Overhead?** None measurable — a child-process spawn with piped stdio and a bounded buffer (a 50 MB log flood is in the test suite).

**From inside Claude Code?** Yes; phantom strips `CLAUDECODE` from the environment before spawning the headless session, so nesting works.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): zero dependencies, tests for behaviour changes, and a written justification for any change to the allowed-tools list or never-touch defaults.

## License

[MIT](LICENSE) © 2026 saaz
