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
const { stripAnsi } = require('../src/ansi');
const { gatherContext } = require('../src/context');
const { runRecovery, parseClaudeOutput, ensureExcluded, commitMessage, offerBranchDecision } = require('../src/recovery');

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

/** Phantom's own output, for the paths whose whole job is to tell the user. */
const capture = () => {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  s.text = () => text;
  return s;
};

/** Runs `fn` with phantom's output captured, and restores the silence after. */
async function withOutput(fn) {
  const out = capture();
  ui.setStream(out);
  try { return { result: await fn(), out: out.text() }; } finally { ui.setStream(quiet); }
}

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
  // Git for Windows defaults core.autocrlf=true in its system config, so a
  // checkout rewrites LF to CRLF and every byte-exact assertion here drifts.
  sh(dir, ['config', 'core.autocrlf', 'false']);
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

test('writing a never-touch file is a violation even when the bytes do not change', async () => {
  // git diff sees nothing here, so only the stat snapshot catches it. That is
  // deliberate: "never touch" is about what the session is allowed to write to,
  // not about whether it managed to alter anything. A session that opens .env
  // for writing has done the thing the rail exists to prevent.
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=hunter2\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-qm', 'track .env']);

  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('touch-tracked'), exit: () => {} });

  assert.equal(res.status, 'error');
  assert.match(res.message, /never-touch violation \(\.env\)/);
  assert.doesNotMatch(res.message, /cannot restore/);
  assert.equal(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'SECRET=hunter2\n');
  assertCleanOriginal(repo);
});

test('a tracked never-touch file is restored, and not reported as unrestorable', async () => {
  // Found by running phantom for real. The stat-snapshot audit flags any
  // never-touch file that changed on disk, and phantom told the user it "cannot
  // restore" a tracked .env that the hard reset put back seconds later --
  // a false alarm on the most alarming message it has.
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=hunter2\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-qm', 'track .env']);

  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('violate-tracked'), exit: () => {} });

  assert.equal(res.status, 'error', 'still a violation -- it was written to');
  assert.match(res.message, /never-touch violation \(\.env\)/);
  assert.doesNotMatch(res.message, /cannot restore/, 'but it was restorable, and was restored');
  assert.match(res.message, /branch reverted/);
  assert.equal(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'SECRET=hunter2\n', 'contents are back');
  assertCleanOriginal(repo);
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

test('a crash outside a git repository is refused before anything is created', async () => {
  // phantom's whole safety story is "your branch is untouched", and every part
  // of it -- the snapshot stash, the fix branch, the hard revert -- is git. With
  // no repo there is nothing to undo a bad session with, so it must stop at the
  // door rather than start editing files in a directory it cannot roll back.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-nogit-')));
  const config = makeConfig(dir);
  const ctx = makeCtx(dir, config);
  assert.equal(ctx.git, null, 'no repository was found');

  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(res.status, 'refused');
  assert.match(res.message, /not a git repository/);
  assert.equal(res.branch, null);
  assert.equal(res.reportPath, null);
  assert.ok(!fs.existsSync(path.join(dir, '.phantom')), 'nothing was written to the directory');

  // Same refusal for a crash context that still names a root, but the repo it
  // named is gone -- a saved .phantom/crashes/*.json replayed later.
  const stale = makeCtx(dir, config);
  stale.git = { root: dir, branch: 'main', detached: false, headSha: 'deadbeef' };
  const staleRes = await runRecovery(stale, config, {}, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(staleRes.status, 'refused');
  assert.match(staleRes.message, /not a git repository/);
});

test('with no test command anywhere, phantom keeps the patch but refuses to call it verified', async () => {
  // Nothing to run means no evidence, and phantom's one rule is that it never
  // reports a fix it did not verify itself. The patch is still worth keeping --
  // it goes to the branch as WIP -- but the status has to say "unverified".
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
  sh(repo, ['commit', '-qam', 'drop the test script']);
  const config = makeConfig(repo, { testCommand: null });
  const ctx = makeCtx(repo, config);
  assert.equal(ctx.testCommand, null, 'and nothing to fall back to');

  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} }));

  assert.equal(res.status, 'unfixed');
  assert.equal(res.testsPassed, null, 'not false: no suite ran at all');
  assert.match(res.message, /could not be verified \(no test run\)/);
  assert.match(out, /no test command available; phantom cannot verify the patch/);
  assert.equal(res.iterations, 1, 'and no point resuming to try again');
  assert.match(sh(repo, ['log', '-1', '--format=%s', res.branch]), /^phantom: WIP \(unfixed\)/);
  assert.equal(sh(repo, ['diff', '--name-only', 'main', res.branch]), 'src/math.js');
  assertCleanOriginal(repo);
});

test('the crash context supplies the test command when the config has none', async () => {
  // The last fallback before giving up: config, then the context captured at
  // crash time, then package.json. This is the middle one -- a saved crash
  // context replayed against a config that no longer sets testCommand, in a
  // repo with no package.json to answer for it.
  const repo = makeRepo();
  fs.unlinkSync(path.join(repo, 'package.json'));
  sh(repo, ['commit', '-qam', 'no package.json']);
  const config = makeConfig(repo, { testCommand: null, maxIterations: 1 });
  const ctx = makeCtx(repo, config);
  assert.equal(ctx.testCommand, null);
  ctx.testCommand = TEST_CMD;

  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(res.status, 'fixed', res.message);
  assert.equal(res.testsPassed, true);
  assert.match(fs.readFileSync(res.reportPath, 'utf8'), /✅ passed — `node --test/);
  assertCleanOriginal(repo);
});

test('a commit that cannot be made keeps the fix and hands it back uncommitted', async () => {
  // A stale .git/index.lock -- a git process that died, or the editor's git
  // integration running at the same moment -- fails `git add`/`git commit`
  // while every read-only query keeps working. The fix is verified and real at
  // that point; dropping it, or checking the user out from under it, would
  // throw away work phantom just proved good.
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);

  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, {}, { env: scenarioEnv('lock-index'), exit: () => {} }));
  fs.unlinkSync(path.join(repo, '.git', 'index.lock'));

  assert.equal(res.status, 'fixed', res.message);
  assert.match(out, /commit failed; changes remain uncommitted on phantom\/fix-/);
  // The reason must be the real one: this used to blame (--no-commit) whatever
  // had actually gone wrong, sending the user to look at a flag they never set.
  assert.match(out, /leaving you on phantom\/fix-.* with uncommitted changes \(commit failed\)/);
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), res.branch, 'left on the phantom branch');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), /a \+ b/, 'the fix is still on disk');
  assert.equal(sh(repo, ['rev-parse', 'main']), sh(repo, ['rev-parse', res.branch]), 'and main never moved');
});

test('when the branch phantom must put you back on is gone, it says so', async () => {
  // Recovery owns the checkout for minutes at a time and the branch it left can
  // disappear underneath it (another shell, another worktree, a session that ran
  // git itself). Failing quietly would leave the user on a phantom/ branch they
  // never asked to be on, believing they are on their own.
  const repo = makeRepo();
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);

  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, {}, { env: scenarioEnv('delete-orig-branch'), exit: () => {} }));

  assert.equal(res.status, 'fixed', res.message);
  assert.match(out, /could not check out main; you are still on phantom\/fix-/);
  assert.equal(sh(repo, ['branch', '--list', 'main']), '', 'main really is gone');
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), res.branch);
  assert.match(sh(repo, ['log', '-1', '--format=%s']), /^phantom: fix /, 'the fix is committed, not lost');
});

test('a snapshot stash that cannot be popped is reported, never silently forgotten', async () => {
  // --allow-dirty means phantom is holding the only copy of the user's
  // uncommitted work. If the pop fails -- the entry dropped by another shell, a
  // conflict -- the one unacceptable outcome is phantom finishing with a green
  // banner and no mention of it.
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// my local edit\n');
  const config = makeConfig(repo);
  const ctx = makeCtx(repo, config);

  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, { allowDirty: true }, { env: scenarioEnv('drop-stash'), exit: () => {} }));

  assert.equal(res.status, 'fixed', res.message);
  // `git stash pop <sha>` and `git stash drop <sha>` are rejected by git ("is
  // not a stash reference"); `apply` is the one form that takes a commit, and
  // it still reaches a dropped entry before gc collects it.
  assert.match(out, /snapshot stash was dropped while phantom was working.*git stash apply [0-9a-f]{10}/);
  // And the banner keeps pointing at it after the summary, where it is read.
  assert.match(out, /your stashed changes: git stash apply [0-9a-f]{10}/);
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('tool calls the guard refused are visible in verbose output', async () => {
  // The deny rules are what stop the session touching .env; when they fire, the
  // only trace the user can ever see is this line. A session that "did nothing"
  // because every edit was denied looks identical to a lazy one without it.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 1 });
  const ctx = makeCtx(repo, config);

  ui.log.setVerbose(true);
  let res;
  let out;
  try {
    ({ result: res, out } = await withOutput(() =>
      runRecovery(ctx, config, {}, { env: scenarioEnv('denied'), exit: () => {} })));
  } finally { ui.log.setVerbose(false); }

  assert.equal(res.status, 'fixed', res.message);
  assert.match(out, /2 tool call\(s\) denied by the guard\/permission rules/);
  assert.match(out, /denied Write \{"file_path":"\.env"\}/);
  assert.match(out, /denied Bash /);
});

test('a branch that vanishes while the prompt waits is not claimed as deleted', async () => {
  // The end-of-run prompt blocks on a human for as long as they take, and
  // "delete it" is the answer that can fail invisibly: another shell removing
  // the branch first turns a confident "deleted X" into a lie about the one
  // thing the user just asked phantom to do. (The rest of this prompt lives in
  // decide.test.js; this arm needs a branch that disappears mid-answer.)
  const repo = makeRepo();
  const branch = 'phantom/fix-x';
  sh(repo, ['branch', branch]);
  const baseSha = sh(repo, ['rev-parse', 'HEAD']);
  const asked = [];
  const ask = (question) => {
    asked.push(question);
    sh(repo, ['branch', '-D', branch]);
    return Promise.resolve('d');
  };

  const { out } = await withOutput(() => offerBranchDecision({ status: 'fixed', branch }, {
    ctx: { git: { branch: 'main' } },
    s: { baseSha, stayed: false, stashed: false, onPhantomBranch: false },
    config: {}, flags: {}, opts: { cwd: repo }, ask,
  }));

  assert.equal(asked.length, 1);
  assert.match(out, /could not delete the branch; run: git branch -D phantom\/fix-x/);
  assert.doesNotMatch(out, /deleted phantom\/fix-x/);
});

test('SIGHUP is handled like the other signals: the tree is restored, not abandoned', async () => {
  // Closing a terminal tab or dropping an SSH session sends SIGHUP. Without a
  // handler phantom simply died mid-recovery, leaving the user on the phantom
  // branch with a live stash, an orphaned claude process, and no message at
  // all. watcher.js has always forwarded all three signals; recovery listened
  // for two of them.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxMinutes: 5 });
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// my local edit\n');
  const ctx = makeCtx(repo, config);
  const exits = [];
  let ctl;
  const promise = runRecovery(ctx, config, { allowDirty: true }, { env: scenarioEnv('sleep'), exit: (c) => exits.push(c), onStart: (c) => { ctl = c; } });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(sh(repo, ['stash', 'list']).split('\n').filter(Boolean).length, 1);
  // Registration is the actual defect: calling ctl.abort() directly works
  // whether or not anything ever listened for the signal, so asserting only on
  // the abort path passes against a phantom that ignores SIGHUP entirely.
  assert.equal(process.listenerCount('SIGHUP'), 1, 'recovery is listening for SIGHUP while it runs');

  await ctl.abort('SIGHUP');
  const res = await promise;

  assert.equal(res.status, 'aborted');
  assert.deepEqual(exits, [129], '128 + SIGHUP, distinct from SIGINT and SIGTERM');
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(sh(repo, ['stash', 'list']), '', 'the snapshot was popped, not left behind');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), /my local edit/);
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '');
  assert.equal(process.listenerCount('SIGHUP'), 0, 'and the handler is removed again');
});

test('phantom restores its own stash even when another one landed on top', async () => {
  // `git stash pop` takes the top of the stack. When something else pushed
  // while phantom was working, the unqualified pop wrote a stranger's content
  // over the user's tree, set stashed = false, and reported success -- with the
  // real work still buried one level down.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxMinutes: 5 });
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// my local edit\n');
  const ctx = makeCtx(repo, config);

  const res = await runRecovery(ctx, config, { allowDirty: true }, { env: scenarioEnv('rival-stash'), exit: () => {} });

  assert.equal(res.status, 'fixed', res.message);
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), /my local edit/,
    "the user's own edit came back");
  assert.ok(!fs.existsSync(path.join(repo, 'rival.txt')), "and the other stash's file was not written over the tree");
  const stashes = sh(repo, ['stash', 'list']).split('\n').filter(Boolean);
  assert.equal(stashes.length, 1, "the other shell's stash is still on the stack, untouched");
  assert.match(stashes[0], /someone-elses-work/);
});

test('failing after the stash is taken still restores the user, and says so', async () => {
  // Every `return result(...)` between the stash and step 9 used to return
  // straight out of the try block without running cleanup(), so the user's
  // entire working tree was left stashed and unmentioned while the final
  // message named an unrelated cause.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxMinutes: 5 });
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// my local edit\n');
  // A branch named `phantom` makes refs/heads/phantom a file, so no
  // refs/heads/phantom/fix-... can be created underneath it.
  sh(repo, ['branch', 'phantom']);
  const ctx = makeCtx(repo, config);

  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, { allowDirty: true }, { env: scenarioEnv('fix'), exit: () => {} }));

  assert.equal(res.status, 'error');
  assert.match(res.message, /could not create branch/);
  assert.equal(sh(repo, ['stash', 'list']), '', 'the snapshot was popped on the way out');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), /my local edit/,
    'the user still has the work they started with');
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.match(out, /could not create branch/, 'and the reason reached the user');
});

test('a secret in the crashed command\'s argv is redacted everywhere it is shown', async () => {
  // The tail was scrubbed from the first release; argv never was. A wrapped
  // command routinely carries credentials -- `node server.js --api-key=...`,
  // `DATABASE_URL=postgres://user:pw@host npm start` -- and that string went
  // verbatim into the prompt sent to the model, the post-mortem on disk, the
  // crash JSON, the desktop notification, and the webhook POST, which is the
  // one destination that leaves the machine entirely.
  const repo = makeRepo();
  const secret = 'sk-ant-api03-zyxwvutsrqponmlkjihgfedcba';
  const dbPassword = 'Hunter2Hunter2';
  const config = makeConfig(repo, { maxIterations: 1 });
  const now = Date.now();
  const ctx = gatherContext({
    command: 'node',
    args: ['src/app.js', '--api-key=' + secret, '--db', 'postgres://app:' + dbPassword + '@db/x'],
    cwd: repo, exitCode: 1, signal: null, startedAt: now - 1, endedAt: now, durationMs: 1,
    tail: 'TypeError: boom\n    at add (' + repo + '/src/math.js:2:42)\n', userInterrupted: false,
  }, config);

  // Raw argv survives on the context, because reproduce() has to re-run it.
  assert.ok(ctx.args.some((a) => a.includes(secret)), 'the real argv is still there to re-run');
  assert.ok(!ctx.commandLine.includes(secret), 'but the displayable form is scrubbed');
  assert.ok(!ctx.commandLine.includes(dbPassword));

  const logFile = path.join(repo, '.phantom', 'fake.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('noop', logFile), exit: () => {} });

  const report = fs.readFileSync(res.reportPath, 'utf8');
  const events = fs.readFileSync(path.join(repo, '.phantom', 'events.jsonl'), 'utf8');
  const prompt = fs.readFileSync(logFile, 'utf8');       // what the session was handed
  const payload = JSON.stringify(require('../src/notify').buildPayload(ctx, res));

  for (const [what, text] of [['report', report], ['events', events], ['prompt log', prompt], ['webhook payload', payload]]) {
    assert.ok(!text.includes(secret), 'api key leaked into the ' + what);
    assert.ok(!text.includes(dbPassword), 'db password leaked into the ' + what);
  }
  assert.match(payload, /\[REDACTED\]/, 'and the webhook still describes the command');
});

test("phantom's own instructions, run verbatim, give the user their work back", async () => {
  // The bug this pins was the worst one phantom has had. When it leaves you on
  // the fix branch it used to skip popping your snapshot (the guard read
  // `!s.onPhantomBranch`, which is still true here) and then print
  // `git stash && git checkout main`. Following that: your tree state is lost,
  // phantom's UNVERIFIED patch lands on the branch it just called untouched,
  // and your real work stays buried under the stash you were told you popped.
  //
  // So the test does what a user does -- it executes the printed advice.
  const repo = makeRepo();
  const config = makeConfig(repo, { autoCommit: false, maxIterations: 1 });
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// MY LOCAL EDIT\n');
  const ctx = makeCtx(repo, config);
  const mainSha = sh(repo, ['rev-parse', 'main']);

  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, { allowDirty: true }, { env: scenarioEnv('fix'), exit: () => {} }));

  assert.equal(res.status, 'fixed');
  assert.equal(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), res.branch, 'precondition: left on the fix branch');
  assert.equal(sh(repo, ['stash', 'list']).split('\n').filter(Boolean).length, 1, 'precondition: snapshot outstanding');

  // Strip colour first. npm exports FORCE_COLOR=1 to lifecycle scripts when
  // stdout is a terminal, so `npm test` in a real shell captures the reset
  // sequence that closes the warning line -- and it lands right after the sha,
  // making the pasted command `git stash apply <sha>\u001b[39m`, which git
  // rejects as "not a valid reference". A piped run and CI both have colour off
  // and never see it. A user copying from their terminal copies the visible
  // text, which is what this reconstructs.
  const advice = (stripAnsi(out).match(/go back with: (.+)/) || [])[1];
  assert.ok(advice, 'phantom told the user how to get back');
  // `git stash pop <sha>` and `git stash drop <sha>` reject a raw commit
  // ("is not a stash reference"), so advice built on them cannot run at all.
  assert.doesNotMatch(advice, /git stash (?:pop|drop) [0-9a-f]{7,}/, 'the advice uses a form git accepts');
  // The point is that the exact string phantom printed runs as typed, so it
  // goes through a shell -- and cmd.exe is the shell a Windows user pastes it
  // into. It chains with && the same way, so the one advice string serves both.
  const [shell, shellArgs] = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', advice]]
    : ['/bin/sh', ['-c', advice]];
  execFileSync(shell, shellArgs, { cwd: repo, stdio: 'pipe' });

  assert.equal(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'back where they started');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), /MY LOCAL EDIT/,
    'and holding the work they had before phantom ran');
  assert.match(fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), /a\.value/,
    "phantom's unverified patch did not follow them onto main");
  assert.equal(sh(repo, ['rev-parse', 'main']), mainSha, 'main never moved');
});

test('a dry run that writes anyway is reported and undone, not called "nothing changed"', async () => {
  // --dry-run had no Bash restriction and never measured the tree, so a session
  // that wrote files left them on the user's OWN branch -- there is no phantom
  // branch in dry run -- while the banner said "nothing changed", the report
  // said "Files changed | none", and the never-touch row claimed a hard revert
  // that never happened.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 1 });
  const ctx = makeCtx(repo, config);
  const baseSha = sh(repo, ['rev-parse', 'HEAD']);
  const originalMath = fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8');

  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, { dryRun: true }, { env: scenarioEnv('dryrun-writes'), exit: () => {} }));

  assert.match(out, /dry run was supposed to change nothing, but the session wrote:.*math\.js/,
    'phantom says what happened');
  assert.equal(res.status, 'error', 'and does not call it a clean dry run');

  // Undone precisely: the tracked edit restored, the created file removed.
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), originalMath);
  assert.ok(!fs.existsSync(path.join(repo, 'sneaky.txt')));
  assert.equal(sh(repo, ['rev-parse', 'HEAD']), baseSha, 'no commit, no branch');
  assert.equal(sh(repo, ['branch', '--list', 'phantom/*']), '', 'a dry run still creates no branch');
  assert.equal(sh(repo, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('a dry run never destroys work the user already had in the tree', async () => {
  // The undo has to be surgical. `reset --hard` would be catastrophic here:
  // dry run takes no stash (it "reads the tree as-is"), so the user's own
  // uncommitted edits are sitting in the same working tree as the session's.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 1 });
  fs.appendFileSync(path.join(repo, 'src', 'app.js'), '// MY OWN WORK\n');
  fs.writeFileSync(path.join(repo, 'my-notes.txt'), 'mine, untracked\n');
  const ctx = makeCtx(repo, config);

  await withOutput(() => runRecovery(ctx, config, { dryRun: true }, { env: scenarioEnv('dryrun-writes'), exit: () => {} }));

  assert.match(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8'), /MY OWN WORK/,
    "the user's tracked edit is untouched");
  assert.ok(fs.existsSync(path.join(repo, 'my-notes.txt')), "and their untracked file still exists");
  // While the session's writes are still undone.
  assert.ok(!fs.existsSync(path.join(repo, 'sneaky.txt')));
  assert.match(fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8'), /a\.value/, 'session edit reverted');
});

test('a clean dry run is still reported as a clean dry run', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { maxIterations: 1 });
  const ctx = makeCtx(repo, config);
  const { result: res, out } = await withOutput(() =>
    runRecovery(ctx, config, { dryRun: true }, { env: scenarioEnv('dryrun'), exit: () => {} }));
  assert.equal(res.status, 'dry-run');
  assert.doesNotMatch(out, /supposed to change nothing/);
  assert.equal(sh(repo, ['status', '--porcelain']), '', 'and the tree really is clean');
});

test('old crash files and post-mortems are pruned, newest kept', async () => {
  // Nothing pruned .phantom/crashes/ or .phantom/reports/: every crash wrote a
  // JSON carrying the whole context (tail included, up to ringBufferBytes) plus
  // a post-mortem, and a month of a crashy dev loop left hundreds of them.
  const repo = makeRepo();
  const config = makeConfig(repo, { keepReports: 3, maxIterations: 1 });
  const crashDir = path.join(repo, '.phantom', 'crashes');
  const reportDir = path.join(repo, '.phantom', 'reports');
  fs.mkdirSync(crashDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  // Filenames are <timestamp>-<slug>, so a lexical sort is chronological.
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(crashDir, '2020010' + i + '-000000-old.json'), '{}');
    fs.writeFileSync(path.join(reportDir, '2020010' + i + '-000000-old.md'), '# old');
  }
  fs.writeFileSync(path.join(reportDir, 'notes.txt'), 'not a report; leave it alone');

  const ctx = makeCtx(repo, config);
  const res = await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(res.status, 'fixed', res.message);

  const crashes = fs.readdirSync(crashDir).filter((f) => f.endsWith('.json')).sort();
  const reports = fs.readdirSync(reportDir).filter((f) => f.endsWith('.md')).sort();
  assert.equal(crashes.length, 3, 'crash JSONs pruned to keepReports');
  assert.equal(reports.length, 3, 'reports pruned to keepReports');
  // The run's own files are the newest, so they must be among the survivors.
  assert.ok(reports.includes(path.basename(res.reportPath)), 'this run\'s report survived');
  // Survivors are the lexically-largest names: the two newest seeded files plus
  // this run's own. 20200100..20200107 are the ones that had to go.
  assert.deepEqual(crashes.slice(0, 2), ['20200108-000000-old.json', '20200109-000000-old.json'],
    'the oldest went first: ' + crashes.join(', '));
  assert.ok(fs.existsSync(path.join(reportDir, 'notes.txt')), 'unrelated files are left alone');
});

test('keepReports: 0 keeps everything', async () => {
  const repo = makeRepo();
  const config = makeConfig(repo, { keepReports: 0, maxIterations: 1 });
  const reportDir = path.join(repo, '.phantom', 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(reportDir, '2020010' + i + '-000000-old.md'), '# old');
  const ctx = makeCtx(repo, config);
  await runRecovery(ctx, config, {}, { env: scenarioEnv('fix'), exit: () => {} });
  assert.equal(fs.readdirSync(reportDir).filter((f) => f.endsWith('.md')).length, 6, 'nothing pruned');
});

test('aborting rescues untracked work instead of deleting it', async () => {
  // cleanup() runs `git clean -fd`, which is unrecoverable: content that was
  // never added has no reflog entry. Phantom tells the user their own branch is
  // untouched, which invites them to keep working while a recovery runs -- and
  // there is only one working tree, so a file they create during the run looks
  // exactly like one the session created. It was simply gone after a Ctrl+C.
  const repo = makeRepo();
  const config = makeConfig(repo, { maxMinutes: 5 });
  const ctx = makeCtx(repo, config);
  let ctl;
  const promise = runRecovery(ctx, config, {}, { env: scenarioEnv('sleep'), exit: () => {}, onStart: (c) => { ctl = c; } });
  await new Promise((r) => setTimeout(r, 900));

  // The user, in another window, while phantom works.
  fs.writeFileSync(path.join(repo, 'my-new-file.js'), 'work I just started\n');

  const { result: res, out } = await withOutput(async () => {
    await ctl.abort('SIGINT');
    return promise;
  });
  assert.equal(res.status, 'aborted');
  assert.ok(!fs.existsSync(path.join(repo, 'my-new-file.js')), 'the tree really was cleaned');

  const hint = /git stash apply ([0-9a-f]{10})/.exec(out);
  assert.ok(hint, 'phantom said where the file went: ' + out);
  execFileSync('git', ['stash', 'apply', hint[1]], { cwd: repo, stdio: 'pipe' });
  assert.equal(fs.readFileSync(path.join(repo, 'my-new-file.js'), 'utf8'), 'work I just started\n',
    'and the command it printed brings the work back');
});
