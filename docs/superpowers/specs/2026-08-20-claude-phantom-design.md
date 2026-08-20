# claude-phantom — design & module contracts

Status: approved by author directive (user asked for autonomous execution with sound defaults).
Date: 2026-08-20

## What it is

`phantom <command>` wraps a developer's command. Zero interference while the command runs
(stdout/stderr streamed through byte-for-byte, exit code preserved). When the process exits
non-zero or dies from a signal (other than the user's own Ctrl+C), phantom captures crash
context and runs a headless Claude Code session (`claude -p`) that diagnoses, writes a failing
regression test, patches, verifies, and writes a post-mortem report — on a dedicated
`phantom/fix-<slug>` branch, never on the user's branch.

Package: `claude-phantom`. Binary: `phantom`. Runtime deps: none. Node >= 18 (uses `fetch`,
`node:test`, `fs.globSync`-free glob matcher of our own).

## Non-goals (v1)

- Supervisor-style detection (nodemon keeps the process alive after a crash) — exit-based only.
- Non-git projects — git is required; phantom refuses recovery without a repo.
- Automatic push / PR creation. Never.

## Layout

```
bin/phantom.js                 # entry: parses argv, calls src/cli.js run()
src/cli.js                     # argv parsing, help, orchestration glue
src/config.js                  # loadConfig(cwd, cliOverrides) -> Config
src/ring-buffer.js             # RingBuffer(maxBytes): push(chunk), toString(), size
src/watcher.js                 # runCommand(cmd, args, opts) -> Promise<RunResult>
src/crash.js                   # extractStackTrace(text), detectCrash(runResult), slugify
src/context.js                 # gatherContext(runResult, config) -> CrashContext (git/package info)
src/git.js                     # git helpers (thin spawnSync wrappers)
src/never-touch.js             # globToRegExp, isNeverTouch(path, globs)
src/prompt.js                  # buildPrompt(ctx, config, mode) -> string; buildSettings(config) -> object
src/recovery.js                # runRecovery(ctx, config) -> Promise<RecoveryResult>
src/report.js                  # fallbackReport(), appendVerification(), banner helpers
src/notify.js                  # sendWebhook(url, payload) (best-effort, 5s timeout)
src/ui.js                      # colors (respect NO_COLOR / !isTTY), banner(), log levels
plugin/.claude-plugin/plugin.json
plugin/skills/crash-recovery/SKILL.md      # THE operating procedure (single source of truth)
plugin/commands/recover.md                 # /phantom:recover — run procedure interactively
templates/post-mortem.md                   # report template (referenced by SKILL.md + prompt.js)
examples/crash-demo/                       # deliberate-crash sample app (node:test tests)
test/*.test.js                             # node:test, zero deps
README.md  LICENSE  CONTRIBUTING.md  CHANGELOG.md  package.json
```

## Config (`.phantomrc` JSON, or `"phantom"` key in package.json; CLI flags override)

```jsonc
{
  "testCommand": "npm test",        // default: package.json scripts.test ? "npm test" : null
  "maxIterations": 3,               // outer fix→verify loop cap (hard)
  "maxMinutes": 15,                 // wall-clock cap for the whole recovery (hard)
  "neverTouch": [".env", ".env.*", "**/*.pem", "**/*.key", "**/secrets/**", "**/*.secret*"],
  "alwaysNeverTouch": [".git/**", "node_modules/**"],  // not user-overridable, merged in
  "webhook": null,                  // optional URL; POST JSON summary on completion
  "model": null,                    // passed to `claude --model` if set
  "autoCommit": true,               // commit on the phantom/fix-* branch only
  "reportDir": ".phantom/reports",
  "ringBufferBytes": 262144,        // 256 KiB of recent output kept
  "claudeBin": "claude"
}
```

CLI: `phantom [flags] -- <command> [args...]` (the `--` is optional; first non-flag token starts
the command). Flags: `--dry-run`, `--allow-dirty`, `--test <cmd>`, `--max-iterations <n>`,
`--max-minutes <n>`, `--model <m>`, `--no-commit`, `--verbose`, `--version`, `--help`.
Env: `PHANTOM_DISABLED=1` → pure passthrough.

## Data contracts

```ts
type RunResult = {
  command: string; args: string[]; cwd: string;
  exitCode: number | null; signal: string | null;
  startedAt: number; endedAt: number; durationMs: number;
  tail: string;             // ring buffer contents (stdout+stderr interleaved, in arrival order)
  userInterrupted: boolean; // phantom saw SIGINT/SIGTERM itself → never recover
};

type CrashContext = RunResult & {
  crashed: true;
  stackTrace: string | null;     // best-effort extracted trace block
  errorLine: string | null;      // first "Error: ..." / "TypeError: ..." style line
  hintFiles: string[];           // repo-relative file paths found in the trace (never-touch filtered)
  slug: string;                  // e.g. "typeerror-cannot-read-properties-of-undefined"
  git: { root: string; branch: string; headSha: string; dirty: boolean;
         status: string; recentCommits: string[] } | null;
  pkg: { name?: string; scripts?: Record<string,string> } | null;
  testCommand: string | null;
  capturedAt: string;            // ISO
};

type RecoveryResult = {
  status: 'fixed' | 'unfixed' | 'dry-run' | 'aborted' | 'refused' | 'timeout' | 'error';
  branch: string | null;
  reportPath: string | null;
  iterations: number;
  testsPassed: boolean | null;
  message: string;
};
```

## Recovery flow (src/recovery.js)

1. Preconditions: git repo; `claude` on PATH; not `PHANTOM_DISABLED`. Dirty tree → `refused`
   unless `--allow-dirty`, in which case `git stash push -u -m "phantom-snapshot-<ts>"` and print
   the exact restore command (`git stash pop`) in the banner and the report.
2. Persist `CrashContext` JSON to `<reportDir>/../crashes/<ts>-<slug>.json` (always, even dry-run —
   the only writes dry-run performs are under `.phantom/`).
3. Non-dry-run: `git checkout -b phantom/fix-<slug>-<shortts>` from HEAD. Record `baseSha`.
4. Spawn `claude -p <prompt> --output-format json --max-turns N --allowedTools ... --disallowedTools ...
   --settings <tmp json with permissions.deny for never-touch + dangerous bash>` with stdin closed,
   `CLAUDECODE` env removed (allows running from inside a Claude Code session), cwd = git root.
   Stream Claude's progress lines to the terminal in dim text when `--verbose`; otherwise a
   spinner-free single status line per phase.
5. Independent verification: phantom runs `testCommand` itself (never trusts Claude's claim).
   Fail → resume the same session (`--resume <session_id>`) with the test output, up to
   `maxIterations` total Claude invocations. Wall-clock timer kills the claude child on `maxMinutes`.
6. Never-touch audit: `git diff --name-only <baseSha>` ∪ untracked; any match → hard-revert the
   branch (`git reset --hard baseSha && git clean -fd`), status `error`, explain in report.
7. On success + autoCommit: `git add -A && git commit -m "phantom: fix <errorLine>"`.
   On failure: leave the branch with an uncommitted/committed WIP clearly labelled, status `unfixed`.
8. Report: Claude writes `<reportDir>/<ts>-<slug>.md` from the template; phantom appends a
   `## Verification (independent)` section + metadata. If Claude produced no report, phantom
   writes the fallback report. Report path is printed and included in the webhook payload.
9. Always return to the original branch (`git checkout <orig>`), restoring the user's world.
   Fix lives on the phantom branch; banner prints `git diff <orig>..<branch>` and merge hints.
10. Ctrl+C / SIGTERM at any point: kill claude child tree, `git reset --hard baseSha`,
    `git clean -fd` (only on the phantom branch), checkout original branch, pop stash if we made
    one, exit 130. Registered once via a single `cleanup()` that is idempotent.

Dry-run: steps 3, 6, 7 skipped; allowed tools are read-only (`Read, Grep, Glob, Bash(git diff*),
Bash(git log*), Bash(git status*)`, plus the test command); Claude's output (diagnosis + proposed
unified diff) is written into the report by phantom. Nothing else is written.

## Headless session tool policy (verified empirically against Claude Code 2.1.237)

Invocation: `claude -p --output-format json --permission-mode dontAsk --max-turns N --allowedTools ...
--disallowedTools ... --settings '<inline JSON>' [--model M] [--resume <session_id>]`, prompt on stdin.
Permission rules use the space-wildcard form (`Bash(npm test *)`), not the legacy `:*` form.

Allowed (fix mode): `Read, Edit, Write, MultiEdit, Grep, Glob, Bash(<testCommand>), Bash(<testCommand> *),
Bash(npm test *), Bash(npm run test *), Bash(npx vitest|jest|mocha *), Bash(node *), Bash(git diff|log|status|show *),
Bash(ls|cat|head|tail|grep|pwd *)`. Dry-run drops Edit/MultiEdit; Write stays but the guard confines it to the
report path. Claude Code auto-approves read-only shell commands in headless mode regardless of the allowlist
(observed: `cat`, `git status`); mutating commands are denied unless listed (observed: `touch` denied).

Three enforcement layers for never-touch + destructive commands:
1. `--settings` permission deny rules (Read/Edit/Write/MultiEdit/Grep/Glob × every never-touch glob) and
   `--disallowedTools` (WebFetch, WebSearch, Task, Agent, NotebookEdit, git push/checkout/switch/reset/stash/
   rebase/commit/clean, rm, curl, wget, npm install/i/ci, npx prisma, sudo).
2. PreToolUse guard hook (`src/guard-hook.js`, fails closed, exit 2) inspecting every Bash/Edit/Write/Read/Grep/
   Glob call: never-touch paths (incl. via cat, redirects, traversal, absolute paths), destructive shell, package
   installs, network clients, migrations, docker/kubectl, DROP/TRUNCATE, state-changing git; dry-run blocks all
   writes except the report.
3. Post-session audit: changed + untracked files vs never-touch globs, plus a size/mtime/inode snapshot of
   never-touch files taken before the session (covers gitignored `.env`; contents never read) → the session's
   changes are discarded on any match. `src/audit.js`.

The captured output tail and stack trace pass through `src/redact.js` before entering the prompt.

## Testing strategy

- Unit (node:test): ring buffer bounds, config precedence, glob matcher, stack-trace extraction,
  slugify, argv parsing, prompt/settings generation (snapshot-ish assertions).
- Integration: spawn real children (clean exit, non-zero exit, throw, signal, 50 MB log flood,
  SIGINT passthrough) through `runCommand`; git helpers against a temp repo.
- E2E (REVIEWER, manual + costs tokens): examples/crash-demo through the full pipeline.
