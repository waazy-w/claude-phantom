---
name: crash-recovery
description: Autonomous crash recovery procedure - diagnose a crash from captured context, write a failing regression test, apply a minimal fix, verify, and write a post-mortem report. Use when given a phantom crash context or asked to recover from a crash.
---

# Crash recovery procedure

You are recovering a crashed command in someone else's repository.  Follow every phase in order. Every hard rule applies in every phase. Evidence beats intuition: never guess when you can read.

## Hard rules (always)

1. NEVER run `git checkout`, `git switch`, `git reset`, `git stash`, `git rebase`, `git merge`, `git commit`, `git push`, `git clean`, `git branch -D`. Phantom owns git. Read-only git (`git diff`, `git log`, `git status`, `git show`) is fine.
2. NEVER run `rm -r`, `rm -rf`, `rmdir`, `sudo`, `chmod -R`, `chown`, `dd`, `mkfs`, `docker`, `kubectl`, or kill processes.
3. NEVER install, remove, or update packages (`npm install`, `npm i`, `npm ci`, `yarn add`, `pnpm add`, `pip install`, ...). NEVER edit lockfiles.
4. NEVER use the network (`curl`, `wget`, `nc`, `ssh`, `scp`, `WebFetch`, `WebSearch`).
5. NEVER run migrations or touch database schemas (`migrate`, `prisma db`, `knex`, `sequelize db`, `drizzle-kit push`, `DROP TABLE`, `TRUNCATE`).
6. NEVER read or edit never-touch paths (the list is injected below the procedure). NEVER edit CI/workflow files (`.github/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/**`), `.gitignore`, or anything under `.git/`.
7. NEVER disable, delete, or skip existing tests. NEVER loosen an assertion. NEVER add `skip`, `only`, `todo`, `xit`, `xdescribe`, or `@pytest.mark.skip`. NEVER change a test's expectation to match broken behavior.
8. NEVER refactor, reformat, rename, reorder imports, bump versions, change dependencies, or "clean up" code you were not asked to fix.
9. Stay inside the repository root. Do not write anywhere outside it except the report path you are given.
10. When a rule and the goal conflict, the rule wins: stop and write a PARTIAL report.

## Phase 0 - Orient

1. Read the crash context you were given in full: command, exit summary, error line, stack trace, hint files, recent output, git status, package scripts, test command.
2. List candidate files from the trace, innermost project frame first. Ignore `node_modules`, `node:`, `internal/` frames.
3. Read every candidate file with the Read tool. Read the callers of the failing function (Grep for its name). Read the nearest existing test file to learn conventions.
4. Identify the test runner from `package.json` scripts and existing test files (node:test, jest, vitest, mocha, pytest, go test, cargo test). Note the exact command that runs ONE test file.
5. Do not proceed until you can point at `file:line` where the failure originates.

## Phase 1 - Diagnose

1. Write a one-paragraph root-cause hypothesis: the mechanism ("X is undefined because Y is never set when Z") with `file:line` evidence for each link in the chain.
2. Distinguish symptom from cause. The throw site is usually the symptom; the cause is where the bad state was produced or where a missing check belongs.
3. If two hypotheses remain, find the evidence that separates them (read more code, run a read-only command) before writing anything.
4. Estimate blast radius: which inputs trigger it, which other callers share the faulty code, whether data is at risk.

## Phase 2 - Reproduce

1. Write ONE failing regression test that exercises the exact cause, using the project's existing runner, directory layout, file naming, and assertion style. Put it next to related tests. Name it after the bug.
2. If the project has no test runner at all: use `node:test` with `node:assert/strict`, create `test/<name>.test.js`, and add `"test": "node --test test/*.test.js"` to `package.json` scripts ONLY if no `test` script exists. Make no other `package.json` changes.
3. Run the new test on its own. Confirm it FAILS, and fails for the right reason (the same error class/message as the crash, not a typo or import error). Paste the failing output into the report later.
4. If you cannot reproduce the crash in a test after two honest attempts, stop and write a PARTIAL report that says what you tried.

## Phase 3 - Patch

1. Make the smallest change that fixes the cause. Prefer fixing the producer of bad state over guarding the consumer. Prefer an explicit check with a clear error over a blanket `try/catch`. Never swallow errors.
2. Preserve behavior for every input that worked before. If the fix changes a public signature or return shape, stop and write PARTIAL.
3. Touch as few files as possible. Typical fix: one source file plus one test file.
4. STOP and write a PARTIAL report (explaining exactly what a human must do and why) if the correct fix would require any of: deleting or migrating data, changing a schema, touching authentication, authorization, payments, billing, cryptography, or secrets handling, editing more than 5 files, adding a dependency, changing infrastructure or CI, or reverting someone else's recent commit.
5. Use Edit for surgical changes. Do not rewrite whole files with Write unless the file is new.

## Phase 4 - Verify

1. Run the injected test command (the project's full test suite). Read the complete output.
2. If anything fails: change the PATCH, never the test's expectations. Re-run. You have at most the injected number of inner attempts.
3. If a test fails that your diff cannot plausibly affect, it was probably already failing before you started (you may not `git stash` to check, so reason from `git diff`). Say so in the report; do not "fix" it.
4. When green, run the new regression test alone once more to confirm it now passes.
5. Run `git diff --stat` and `git status --porcelain`. Confirm that only intended files changed and no never-touch path appears. If one does, revert that file with Edit (not git) and explain.
6. If attempts are exhausted and tests are still red, proceed to Phase 5 with status UNFIXED and leave your best patch in place, clearly described.

## Phase 5 - Report

1. Write the post-mortem to the exact report path you were given, using the Write tool, following the provided template section by section. Fill every section; write "none" rather than leaving a section empty.
2. Status line: `✅ FIXED` only when the full test command passed under your own run. `⚠️ PARTIAL` when you stopped on purpose. `❌ UNFIXED` when attempts ran out. `🔍 DRY RUN` in dry-run mode.
3. Keep the `<!-- phantom:verification -->` marker exactly as-is. Phantom replaces it with its own independent verification.
4. Root cause must cite `file:line`. The fix section must contain the unified diff of your source changes (`git diff` output). The regression-test section must contain the test code and its failing output from Phase 2.
5. Alternatives / follow-ups: list what you rejected and what a human should still check. Be concrete.
6. Your final message must be a three-line summary: status, files changed, one-sentence root cause.

## Dry-run variant

1. Everything above applies, except you make NO changes to the repository: no Edit, no Write, no MultiEdit, except the single Write of the report file.
2. You may still read files, Grep, Glob, run read-only git commands, and run the test command.
3. Present the regression test and the fix as unified diffs inside the report ("The fix" and "Regression test" sections). Status is `🔍 DRY RUN`.
4. Be explicit about what you could not verify because you could not run the patched code.
