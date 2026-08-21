'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Writable } = require('node:stream');
const ui = require('../src/ui');
const git = require('../src/git');
const { gatherContext } = require('../src/context');
const { runRecovery, parseClaudeOutput, ensureExcluded, commitMessage } = require('../src/recovery');

const FAKE_SCRIPT = path.join(__dirname, 'fixtures', 'fake-claude.js');

/**
 * Windows honours no shebang: a bare .js path is not a program there, and
 * whichever way phantom spawns claudeBin it loses -- through cmd.exe the file
 * association hands it to Windows Script Host, which runs nothing and exits 0,
 * and a direct spawn cannot start it at all. A .cmd shim is the one shape both
 * routes launch, and it is the shape the real `claude` takes on Windows anyway.
 * Generated at run time so no platform-specific fixture is committed.
 * @returns {string} path to an executable stand-in for `claude`
 */
function fakeClaudeBin() {
  if (process.platform !== 'win32') return FAKE_SCRIPT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-bin-'));
  const shim = path.join(dir, 'fake-claude.cmd');
  fs.writeFileSync(shim, '@"' + process.execPath + '" "' + FAKE_SCRIPT + '" %*\r\n');
  return shim;
}

const FAKE = fakeClaudeBin();
// A literal path, not test/*.test.js: cmd.exe does not expand globs, so the
// glob would reach node verbatim and no test file would ever be found.
const TEST_CMD = 'node --test test/math.test.js';
const quiet = new Writable({ write(c, e, cb) { cb(); } });
ui.setStream(quiet);

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  // .native, because os.tmpdir() hands back an 8.3 short name on Windows while
  // git and the claude child's process.cwd() both report the long form.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-rec-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: TEST_CMD } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), "'use strict';\nfunction add(a, b) { return a.value + b; }\nmodule.exports = { add };\n");
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), "const { add } = require('./math');\nconsole.log(add(1, 2).toFixed(1));\n");
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('../src/math');\ntest('add', () => { assert.equal(add(1, 2), 3); });\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@example.com']);
  sh(dir, ['config', 'user.name', 'tester']);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function makeConfig(repo, overrides = {}) {
  return {
    testCommand: TEST_CMD, maxIterations: 3, maxMinutes: 5,
    neverTouch: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/secrets/**', '.git/**', 'node_modules/**'],
    alwaysNeverTouch: ['.git/**', 'node_modules/**'], webhook: null, model: null, autoCommit: true,
    reportDir: '.phantom/reports', ringBufferBytes: 65536, claudeBin: FAKE, ...overrides,
  };
}

function makeCtx(repo, config) {
  const tail = "starting\n/tmp/x/src/math.js:2\nfunction add(a, b) { return a.value + b; }\n                                      ^\n\nTypeError: Cannot read properties of undefined (reading 'value')\n    at add (" + repo + "/src/math.js:2:42)\n    at Object.<anonymous> (" + repo + "/src/app.js:2:13)\n\nNode.js v22.0.0\n";
  const now = Date.now();
  return gatherContext({ command: 'node', args: ['src/app.js'], cwd: repo, exitCode: 1, signal: null, startedAt: now - 100, endedAt: now, durationMs: 100, tail, userInterrupted: false }, config);
}

function scenarioEnv(scenario, logFile) {
  const env = { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_LOG: logFile || '' };
  // The fixture project runs `node --test` itself; it must not inherit the
  // outer runner's child-process marker or it silently reports success.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function readLog(logFile) {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

function assertCleanOriginal(repo) {
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(sh(repo, ['status', '--porcelain']), '', 'original branch must be clean');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), /a\.value/, 'bug still present on main');
}

test('happy path: fix lands on a phantom branch, report has verification, user returns to main', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  assert.equal(ctx.errorLine, "TypeError: Cannot read properties of undefined (reading 'value')");
  const logFile = path.join(repo, '.phantom', 'fake.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const baseSha = sh(repo, ['rev-parse', 'HEAD']);

  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix', logFile), exit: () => {} });

  assert.equal(res.status, 'fixed', res.message);
  assert.equal(res.iterations, 1);
  assert.equal(res.testsPassed, true);
  assert.match(res.branch, /^phantom\/fix-typeerror-cannot-read-properties-/);
  assertCleanOriginal(repo);
  assert.equal(sh(repo, ['rev-parse', 'main']), baseSha);
  const log = sh(repo, ['log', '--format=%H %s', res.branch]).split('\n');
  assert.equal(log.length, 2);
  assert.match(log[0], /phantom: fix TypeError: Cannot read properties of undefined \(read/);
  assert.match(sh(repo, ['log', '-1', '--format=%b', res.branch]), /Base: [0-9a-f]{40}/);
  assert.equal(sh(repo, ['diff', '--name-only', 'main', res.branch]), 'src/math.js');
  assert.ok(fs.existsSync(res.reportPath));
  const md = fs.readFileSync(res.reportPath, 'utf8');
  assert.match(md, /## Verification \(independent\)/);
  assert.match(md, /✅ passed — `node --test/);
  assert.match(md, /`src\/math\.js`/);
  assert.match(md, /Never-touch audit \| ✅ clean/);
  assert.ok(!md.includes('{{iterations}}') && md.includes('| **Iterations** | 1 |'));
  assert.ok(!md.includes('{{branch}}'));
  assert.match(md, /12\.2k tokens/);
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.phantom\/$/m);
  const crashes = fs.readdirSync(path.join(repo, '.phantom', 'crashes'));
  assert.equal(crashes.length, 1);
  assert.match(crashes[0], /^\d{8}-\d{6}-typeerror-cannot-read-properties\.json$/);
  const calls = readLog(logFile);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resumed, false);
  assert.equal(calls[0].env.CLAUDECODE, null);
  assert.equal(calls[0].cwd, repo);
  assert.ok(calls[0].args.includes('--resume') === false);
  assert.ok(calls[0].args.includes('Bash(' + TEST_CMD + ')'));
  assert.ok(calls[0].promptBytes > 5000);
  assert.equal(calls[0].reportPath, res.reportPath);
});

test('failing tests resume the same session with feedback until green', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const logFile = path.join(repo, '.phantom', 'fake.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fail-then-fix', logFile), exit: () => {} });
  assert.equal(res.status, 'fixed', res.message);
  assert.equal(res.iterations, 2);
  const calls = readLog(logFile);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resumed, true);
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], 'fake-session-1');
  assert.ok(calls[1].promptBytes < calls[0].promptBytes / 4, 'resume prompt is short');
  assertCleanOriginal(repo);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /Iterations used \| 2/);
  assert.equal(res.sessionId, 'fake-session-1');
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /\| Session \| `fake-session-1` — transcript in `~\/.claude\/projects\/`, reopen with `claude --resume fake-session-1`/);
});

test('a green suite cannot mean "fixed" while the crashed command still crashes', async () => {
  // The other half of the same lie. Here the session does change code and the
  // suite does pass -- but `node src/app.js`, the command that crashed, still
  // exits non-zero. Tests are evidence about the code; only re-running the
  // command answers the question the user actually asked.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 1 });
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('tests-only'), exit: () => {} });

  assert.equal(res.testsPassed, true, 'the suite really did pass');
  assert.equal(res.status, 'unfixed', 'but the command still crashes');
  assert.match(res.message, /still exits 3/);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /Crashed command re-run \| ❌ still exits 3/);
  assertCleanOriginal(repo);
});

test('the happy path re-runs the crashed command and says so', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} });

  assert.equal(res.status, 'fixed');
  assert.match(res.message, /no longer crashes/);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /Crashed command re-run \| ✅ exits 0/);
});

test('a command that is still running at the cutoff counts as fixed', async () => {
  // The `phantom npm run dev` case, and the reason the re-run has a timeout at
  // all: a server that crashed on boot and now stays up will never exit, so
  // waiting for an exit code would hang the recovery forever. Surviving well
  // past the point it used to die is the evidence.
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, {
    env: scenarioEnv('long-running'), exit: () => {}, reproTimeoutMs: 1500,
  });

  assert.equal(res.status, 'fixed');
  assert.match(res.message, /no longer crashes/);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /Crashed command re-run \| ✅ still running after \d+s, no crash/);
});

test('verifyCommand: false skips the re-run entirely', async () => {
  const repo = makeRepo();
  // Opting out must not turn a broken entry point into a pass by accident: with
  // no re-run there is simply no claim about the command either way.
  const config = makeConfig(repo, { maxIterations: 1, verifyCommand: false });
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('tests-only'), exit: () => {} });

  assert.equal(res.status, 'fixed', 'without the re-run, green tests are all phantom has');
  assert.doesNotMatch(res.message, /no longer crashes/);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /Crashed command re-run \| ⏭ not re-run/);
});

test('a green suite cannot mean "fixed" when the session changed nothing', async () => {
  // Found by running phantom for real: the session wrote no code at all, the
  // existing tests passed -- as they had while the command was crashing, since
  // they never covered the bug -- and phantom announced "fix verified". The
  // crashed command still crashed. Passing tests only mean something in
  // combination with a change; on their own they are the status quo.
  const repo = makeRepo();
  // A suite that passes no matter what -- standing in for real tests that simply
  // do not cover the crashing path, which is the common case.
  const config = makeConfig(repo, { maxIterations: 1, testCommand: 'node -e ""' });
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('silent-noop'), exit: () => {} });

  assert.equal(res.testsPassed, true, 'the suite really did pass');
  assert.equal(res.status, 'unfixed', 'but nothing was fixed');
  assert.match(res.message, /made no changes/);
  assert.equal(res.branch, null, 'and there is no branch to offer');
  assertCleanOriginal(repo);
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '');
});

test('claude writes nothing: fallback report, unfixed, empty branch removed', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 1 });
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('noop'), exit: () => {} });
  assert.equal(res.status, 'unfixed');
  assert.equal(res.testsPassed, false);
  assert.equal(res.branch, null, 'branch with no changes is deleted');
  assertCleanOriginal(repo);
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '');
  const md = fs.readFileSync(res.reportPath, 'utf8');
  assert.match(md, /❌ UNFIXED/);
  assert.match(md, /Claude's final message/);
  assert.match(md, /I could not determine the cause/);
  assert.match(md, /error_max_turns/);
  assert.match(md, /❌ failed — `node --test/);
  assert.match(md, /not ok|✖|fail 1/);
  assert.match(md, /none \(no changes were made/);
});

test('never-touch violation hard-reverts the branch and reports error', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('violate'), exit: () => {} });
  assert.equal(res.status, 'error');
  assert.match(res.message, /never-touch violation \(\.env\)/);
  assertCleanOriginal(repo);
  assert.ok(!fs.existsSync(path.join(repo, '.env')), '.env removed by the revert');
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '');
  const md = fs.readFileSync(res.reportPath, 'utf8');
  assert.match(md, /❌ violated — `\.env`/);
  assert.match(md, /\*\*Status:\*\* ❌ UNFIXED \(set by phantom/);
});

test('edits to a gitignored never-touch file are detected even though git cannot see them', async () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, '.gitignore'), '.env\n');
  sh(repo, ['commit', '-qam', 'ignore env']);
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=original\n');
  const past = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(repo, '.env'), past, past);
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('violate-ignored'), exit: () => {} });
  assert.equal(res.status, 'error');
  assert.match(res.message, /never-touch violation \(\.env\)/);
  assert.match(res.message, /cannot restore/);
  assertCleanOriginal(repo);
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '');
  assert.match(fs.readFileSync(path.join(repo, '.env'), 'utf8'), /INJECTED/, 'phantom must not touch the file itself');
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /\.env/);
});

test('dry run creates no branch and changes no tracked files', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const logFile = path.join(repo, '.phantom', 'fake.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const res = await runRecovery(ctx, config, { dryRun: true }, { env: scenarioEnv('dryrun', logFile), exit: () => {} });
  assert.equal(res.status, 'dry-run');
  assert.equal(res.branch, null);
  assertCleanOriginal(repo);
  assert.equal(sh(repo, ['branch', '--list']).trim(), '* main');
  const md = fs.readFileSync(res.reportPath, 'utf8');
  assert.match(md, /Dry run: proposed diff only/);
  assert.match(md, /none \(dry run\)/);
  const calls = readLog(logFile);
  assert.ok(!calls[0].args.includes('Edit'));
  assert.ok(calls[0].args.includes('Write'));
  // The --settings blob is a single argv element full of spaces, quotes, braces
  // and globs; on Windows it also has to survive cmd.exe and the .cmd shim's own
  // parse, so round-tripping the deny list is the end-to-end escaping check.
  const settings = JSON.parse(calls[0].args[calls[0].args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions.deny.filter((r) => r.startsWith('Write(')), config.neverTouch.map((g) => 'Write(' + g + ')'));
  // buildSettings ships no hooks on win32 (the hook command is a POSIX shell
  // line), so dry run rests on --allowedTools there; assert the guard's dryRun
  // flag only where the hook actually exists.
  if (process.platform !== 'win32') assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /"dryRun":true/);
});

test('dry run tolerates a dirty tree', async () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// local edit\n');
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, { dryRun: true }, { env: scenarioEnv('dryrun'), exit: () => {} });
  assert.equal(res.status, 'dry-run');
  assert.match(sh(repo, ['status', '--porcelain']), /^ ?M src\/app\.js$/m);
});

test('dirty tree is refused without --allow-dirty and stashed/restored with it', async () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// local edit\n');
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked\n');
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const refused = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(refused.status, 'refused');
  assert.match(refused.message, /--allow-dirty/);

  const res = await runRecovery(ctx, config, { allowDirty: true }, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(res.status, 'fixed', res.message);
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), /local edit/, 'stash popped');
  assert.ok(fs.existsSync(path.join(repo, 'scratch.txt')));
  assert.equal(sh(repo, ['stash', 'list']), '');
});

test('timeout kills claude, yields status timeout and a clean original branch', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { maxMinutes: 0.03, maxIterations: 3 });
  const ctx = makeCtx(repo, config);
  const t0 = Date.now();
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('sleep'), exit: () => {} });
  assert.equal(res.status, 'timeout');
  assert.ok(Date.now() - t0 < 15000, 'did not wait for the 30 s sleeper');
  assert.equal(res.iterations, 1);
  assertCleanOriginal(repo);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /\*\*Status:\*\* ❌ UNFIXED \(set by phantom: recovery exceeded/);
});

test('SIGINT during the session restores the original branch and exits 130', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { maxMinutes: 5 });
  const ctx = makeCtx(repo, config);
  const exits = [];
  let ctl;
  const t0 = Date.now();
  const promise = runRecovery(ctx, config, {}, { env: scenarioEnv('sleep'), exit: (c) => exits.push(c), onStart: (c) => { ctl = c; } });
  await new Promise((r) => setTimeout(r, 1200));
  assert.match(sh(repo, ['symbolic-ref', '--short', 'HEAD']), /^phantom\/fix-/, 'on the phantom branch while claude runs');
  fs.writeFileSync(path.join(repo, 'src', 'math.js'), 'half-written edit');
  fs.writeFileSync(path.join(repo, 'junk.js'), 'untracked junk');
  await ctl.abort('SIGINT');
  const res = await promise;
  assert.equal(res.status, 'aborted');
  assert.deepEqual(exits, [130]);
  assert.ok(Date.now() - t0 < 15000);
  assertCleanOriginal(repo);
  assert.ok(!fs.existsSync(path.join(repo, 'junk.js')));
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '');
  assert.ok(fs.existsSync(path.join(repo, '.phantom', 'crashes')), '.phantom survives git clean');
  assert.equal(process.listenerCount('SIGINT'), 0);
});

test('unparsable claude output becomes an error result, not a crash', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 2 });
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('garbage'), exit: () => {} });
  assert.equal(res.status, 'unfixed');
  assert.equal(res.iterations, 1, 'no session id, so no resume');
  assertCleanOriginal(repo);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /this is not json/);
});

test('missing claude binary yields error with install hint', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { claudeBin: path.join(repo, 'definitely-not-claude') });
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { exit: () => {} });
  assert.equal(res.status, 'error');
  assert.match(res.message, /npm install -g @anthropic-ai\/claude-code/);
  assertCleanOriginal(repo);
});

test('no-commit leaves the fix uncommitted on the phantom branch', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { autoCommit: false });
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(res.status, 'fixed');
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), res.branch);
  assert.match(sh(repo, ['status', '--porcelain']), /^ ?M src\/math\.js$/m);
  assert.equal(sh(repo, ['rev-parse', 'main']), sh(repo, ['rev-parse', res.branch]));
});

test('parseClaudeOutput, ensureExcluded and commitMessage helpers', () => {
  assert.equal(parseClaudeOutput('{"result":"ok","session_id":"s"}').session_id, 's');
  assert.equal(parseClaudeOutput('noise\n{"result":"ok","session_id":"s2"}\n').session_id, 's2');
  assert.equal(parseClaudeOutput('garbage').is_error, true);
  const repo = makeRepo();
  ensureExcluded(repo, '.phantom');
  ensureExcluded(repo, '.phantom');
  const ex = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal((ex.match(/^\.phantom\/$/gm) || []).length, 1);
  const msg = commitMessage({ errorLine: 'E'.repeat(100), exitCode: 1, signal: null, command: 'x', args: [] }, 'fixed', '.phantom/reports/r.md', 'abc');
  assert.match(msg, /^phantom: fix E{60}\n\nAutomated fix by claude-phantom\. Crash: exit code 1\nReport: \.phantom\/reports\/r\.md\nBase: abc$/);
});

test('allow-dirty: abort while claude runs pops the snapshot stash and keeps the user edit', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { maxMinutes: 5 });
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// my local edit\n');
  const ctx = makeCtx(repo, config);
  const exits = [];
  let ctl;
  const promise = runRecovery(ctx, config, { allowDirty: true }, { env: scenarioEnv('sleep'), exit: (c) => exits.push(c), onStart: (c) => { ctl = c; } });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(sh(repo, ['stash', 'list']).split('\n').filter(Boolean).length, 1, 'snapshot stash exists during recovery');
  await ctl.abort('SIGINT');
  const res = await promise;
  assert.equal(res.status, 'aborted');
  assert.deepEqual(exits, [130]);
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(sh(repo, ['stash', 'list']), '', 'stash popped');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), /my local edit/);
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '');
  assert.equal(process.listenerCount('SIGINT'), 0);
});

test('a signal after recovery finished does not reset the fix branch', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const exits = [];
  let ctl;
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: (c) => exits.push(c), onStart: (c) => { ctl = c; } });
  assert.equal(res.status, 'fixed');
  const fixSha = sh(repo, ['rev-parse', res.branch]);
  await ctl.abort('SIGINT');
  assert.deepEqual(exits, [130]);
  assert.equal(sh(repo, ['rev-parse', res.branch]), fixSha, 'commit on the phantom branch survives');
  assertCleanOriginal(repo);
});

test('secrets printed by the app never reach the crash JSON, the prompt, or the fallback report', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 1 });
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  const now = Date.now();
  const tail = '[boot] FAKE_TOKEN=' + secret + '\nPASSWORD=hunter2\nTypeError: boom\n    at add (' + repo + '/src/math.js:2:42)\n';
  const ctx = gatherContext({ command: 'node', args: ['src/app.js'], cwd: repo, exitCode: 1, signal: null, startedAt: now - 1, endedAt: now, durationMs: 1, tail, userInterrupted: false }, config);
  const logFile = path.join(repo, '.phantom', 'fake.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('noop', logFile), exit: () => {} });
  assert.equal(res.status, 'unfixed');
  const crashDir = path.join(repo, '.phantom', 'crashes');
  const crashJson = fs.readFileSync(path.join(crashDir, fs.readdirSync(crashDir)[0]), 'utf8');
  const report = fs.readFileSync(res.reportPath, 'utf8');
  for (const text of [crashJson, report]) assert.ok(!text.includes(secret) && !text.includes('hunter2'), 'secret leaked');
  assert.ok(crashJson.includes('[REDACTED]'));
});
