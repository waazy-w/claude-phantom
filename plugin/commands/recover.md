---
description: Recover from a crash interactively - diagnose, write a failing test, patch on a phantom/fix-* branch, verify, and write a post-mortem
argument-hint: "[path to .phantom/crashes/*.json | pasted error text]"
allowed-tools: Read, Edit, Write, MultiEdit, Grep, Glob, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git rev-parse:*), Bash(git branch:*), Bash(git stash list:*), Bash(git checkout -b:*), Bash(git add:*), Bash(git commit:*), Bash(npm test *), Bash(npm test), Bash(npm run test *), Bash(npx vitest *), Bash(npx jest *), Bash(npx mocha *), Bash(node *), Bash(ls *), Bash(ls), Bash(cat *), Bash(head *), Bash(tail *), Bash(pwd)
---

Recover from a crash using the `crash-recovery` skill. You are running interactively, so you own the git branch setup that phantom's CLI would otherwise handle.

## Input

`$ARGUMENTS`

- If the argument is a path ending in `.json`, read it: it is a phantom `CrashContext` (command, exit summary, errorLine, stackTrace, hintFiles, tail, git, pkg, testCommand).
- If the argument is empty, find the newest file in `.phantom/crashes/` (`ls -t .phantom/crashes/*.json | head -1`) and read it. If there is none, ask the user to paste the error or run the crashing command.
- Otherwise treat the argument as pasted error output: extract the error line, stack trace, and file paths yourself.

## Setup (interactive only)

1. Run `git status --porcelain`. If the tree is dirty, stop and ask the user to commit or stash first (never stash for them).
2. Record the base: `git rev-parse --abbrev-ref HEAD` and `git rev-parse HEAD`.
3. Derive a slug from the error line (lowercase, `a-z0-9-`, at most 48 chars) and create the branch: `git checkout -b phantom/fix-<slug>`. This is the ONE git mutation you may perform in this command; it is forbidden inside the skill's phases.
4. Determine the test command: `.phantomrc` `testCommand`, else `package.json` `scripts.test` (`npm test`), else `node --test test/*.test.js`.
5. Never-touch paths: `.env`, `.env.*`, `**/*.pem`, `**/*.key`, `**/secrets/**`, `**/*.secret*`, `.git/**`, `node_modules/**`, plus any `neverTouch` in `.phantomrc`.

## Procedure

Follow the `crash-recovery` skill phases 0 through 5 exactly, with at most 3 verification attempts. Write the report to `.phantom/reports/<YYYYMMDD-HHmmss>-<slug>.md` using the template at `${CLAUDE_PLUGIN_ROOT}/templates/post-mortem.md`, which ships with this plugin. If it cannot be read, fall back to `templates/post-mortem.md` in the repo, and only then to the same section order from memory.

## Finish

1. Show `git diff --stat` and the report path.
2. Ask the user whether to commit on the phantom branch (`git add -A && git commit -m "phantom: fix <error>"`). Do not commit without a yes.
3. Remind them how to review: `git diff <base>..phantom/fix-<slug>`, `git merge`, or `git branch -D` to discard. Do not switch branches back yourself; the user decides.
