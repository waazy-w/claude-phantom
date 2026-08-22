'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Writable } = require('node:stream');
const ui = require('../src/ui');
const { gatherContext } = require('../src/context');
const { listCrashes, loadCrash, runReplay, crashDirOf } = require('../src/replay');

const quiet = new Writable({ write(c, e, cb) { cb(); } });
ui.setStream(quiet);

/** Phantom's own output, for the paths whose whole job is to tell the user. */
const capture = () => {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  s.text = () => text;
  return s;
};

async function withOutput(fn) {
  const out = capture();
  ui.setStream(out);
  try { return { result: await fn(), out: out.text() }; } finally { ui.setStream(quiet); }
}

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A fixed clock, so "captured 40 days ago" means the same thing on every run.
const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function makeRepo(prefix = 'phantom-replay-') {
  // .native, because os.tmpdir() hands back an 8.3 short name on Windows while
  // git and process.cwd() both report the long form.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.writeFileSync(path.join(dir, 'app.js'), "const { add } = require('./math');\nconsole.log(add(1, 2));\n");
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@example.com']);
  sh(dir, ['config', 'user.name', 'tester']);
  sh(dir, ['config', 'core.autocrlf', 'false']);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function makeConfig(overrides = {}) {
  return {
    testCommand: 'node --test', maxIterations: 3, maxMinutes: 5, neverTouch: ['.env'], webhook: null,
    model: null, autoCommit: true, reportDir: '.phantom/reports', ringBufferBytes: 65536, claudeBin: 'claude',
    ...overrides,
  };
}

function makeCtx(repo, config, overrides = {}) {
  const tail = "starting\nTypeError: Cannot read properties of undefined (reading 'value')\n    at add (" + repo + "/app.js:2:42)\n";
  const ctx = gatherContext({
    command: 'node', args: ['app.js'], cwd: repo, exitCode: 1, signal: null,
    startedAt: NOW - 100, endedAt: NOW, durationMs: 100, tail, userInterrupted: false,
  }, config);
  ctx.capturedAt = new Date(NOW).toISOString();
  return { ...ctx, ...overrides };
}

/** Write a capture exactly where recovery.js step 2 writes one. */
function saveCrash(repo, ctx, name) {
  const dir = crashDirOf(repo, '.phantom/reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name || '20260821-120000-' + ctx.slug + '.json');
  fs.writeFileSync(file, JSON.stringify(ctx, null, 2));
  return file;
}

test('listCrashes: newest first by capture time, with unreadable files kept and labelled', () => {
  const repo = makeRepo();
  const config = makeConfig();
  // Filenames deliberately disagree with capturedAt: the timestamp inside the
  // capture is what the user means by "the newest crash".
  saveCrash(repo, makeCtx(repo, config, { capturedAt: daysAgo(3) }), 'a-oldest.json');
  saveCrash(repo, makeCtx(repo, config, { capturedAt: daysAgo(0) }), 'b-newest.json');
  saveCrash(repo, makeCtx(repo, config, { capturedAt: daysAgo(1) }), 'c-middle.json');
  const dir = crashDirOf(repo, '.phantom/reports');
  fs.writeFileSync(path.join(dir, 'truncated.json'), '{"command": "node", "gi');
  fs.writeFileSync(path.join(dir, 'empty-object.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a capture');

  const entries = listCrashes(repo, { now: NOW });
  assert.deepEqual(entries.filter((e) => e.ok).map((e) => e.name), ['b-newest.json', 'c-middle.json', 'a-oldest.json']);
  assert.equal(entries.length, 5, 'unreadable captures are listed too: ' + entries.map((e) => e.name).join(', '));
  assert.ok(!entries.some((e) => e.name === 'notes.txt'), 'non-JSON files are ignored');

  // The three valid captures, newest first; a file with no usable timestamp can
  // only be ordered by mtime, so it is not necessarily below them.
  const newest = entries.find((e) => e.ok);
  assert.equal(newest.commandLine, 'node app.js');
  assert.equal(newest.errorLine, "TypeError: Cannot read properties of undefined (reading 'value')");
  assert.equal(newest.exitSummary, 'exit code 1');
  assert.equal(newest.root, repo);
  assert.equal(newest.branch, 'main');
  assert.equal(newest.ageMs, 0);

  const truncated = entries.find((e) => e.name === 'truncated.json');
  assert.equal(truncated.ok, false);
  assert.match(truncated.problem, /^unreadable: /);
  const emptyObject = entries.find((e) => e.name === 'empty-object.json');
  assert.equal(emptyObject.ok, false);
  assert.match(emptyObject.problem, /missing or invalid: command, slug, git\.root/);

  assert.deepEqual(listCrashes(makeRepo(), { now: NOW }), [], 'a repo that never crashed lists nothing');
});

test('loadCrash: the newest capture is handed back byte-for-byte', () => {
  const repo = makeRepo();
  const config = makeConfig();
  const old = makeCtx(repo, config, { capturedAt: daysAgo(2) });
  const fresh = makeCtx(repo, config, { capturedAt: daysAgo(0) });
  saveCrash(repo, old, 'z-old.json');
  const freshPath = saveCrash(repo, fresh, 'a-fresh.json');

  const res = loadCrash(null, repo, { now: NOW });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.entry.path, freshPath);
  // Unchanged is the contract -- runRecovery's only account of the crash is this
  // object, so anything refreshed here would describe the present, not the crash
  // -- with exactly one exception, below: testCommand is stripped, because a
  // saved file does not get to choose what gets executed.
  const onDisk = JSON.parse(fs.readFileSync(freshPath, 'utf8'));
  delete onDisk.testCommand;
  assert.deepEqual(res.ctx, onDisk);
  assert.equal(res.ctx.testCommand, undefined);
  assert.deepEqual(res.warnings, []);

  const named = loadCrash('.phantom/crashes/z-old.json', repo, { now: NOW, cwd: repo });
  assert.equal(named.ok, true, named.message);
  assert.equal(named.ctx.capturedAt, old.capturedAt, 'a named capture wins over the newest');
});

test('loadCrash: a capture from another repository is refused, not replayed here', () => {
  // runRecovery works in ctx.git.root, not in the directory phantom was invoked
  // from -- so a capture copied in from another checkout would quietly stash,
  // branch, patch and commit over there, in a project nobody is looking at.
  const repo = makeRepo();
  const other = makeRepo('phantom-replay-other-');
  const config = makeConfig();
  const foreign = makeCtx(other, config);
  assert.equal(foreign.git.root, other);
  saveCrash(repo, foreign, 'foreign.json');

  const res = loadCrash(null, repo, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'wrong-repo');
  assert.ok(res.message.includes(other) && res.message.includes(repo), res.message);
  assert.match(res.hint, /cd .*phantom-replay-other/);

  // No --force for this one: the fix for a capture that belongs elsewhere is to
  // replay it there.
  assert.equal(loadCrash(null, repo, { now: NOW, force: true }).reason, 'wrong-repo');

  // Same refusal once that repository is gone, which is the shape a stale
  // capture takes after the checkout it names has been deleted.
  fs.rmSync(other, { recursive: true, force: true });
  const gone = loadCrash(null, repo, { now: NOW });
  assert.equal(gone.reason, 'wrong-repo');
  assert.match(gone.message, /no longer exists/);
});

test('loadCrash: a base commit this repository has never seen is refused, --force overrides', () => {
  const repo = makeRepo();
  const config = makeConfig();
  const ctx = makeCtx(repo, config);
  ctx.git.headSha = 'deadbeef'.repeat(5);
  saveCrash(repo, ctx);

  const res = loadCrash(null, repo, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-base');
  assert.match(res.message, /deadbeefde/);
  assert.match(res.hint, /--force/);

  const forced = loadCrash(null, repo, { now: NOW, force: true });
  assert.equal(forced.ok, true);
  assert.ok(forced.warnings.some((w) => /deadbeefde.*--force/s.test(w)), forced.warnings.join(' | '));
});

test('loadCrash: a capture older than the age cap is refused, --force overrides', () => {
  const repo = makeRepo();
  const config = makeConfig();
  saveCrash(repo, makeCtx(repo, config, { capturedAt: daysAgo(45) }));

  const res = loadCrash(null, repo, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'stale');
  assert.match(res.message, /45d ago/);

  assert.equal(loadCrash(null, repo, { now: NOW, force: true }).ok, true);
  assert.equal(loadCrash(null, repo, { now: NOW, maxAgeDays: 60 }).ok, true, 'the cap is configurable');
});

test('loadCrash: nothing to load, or something that is not a crash context', () => {
  const repo = makeRepo();
  const config = makeConfig();

  const none = loadCrash(null, repo, { now: NOW });
  assert.equal(none.reason, 'no-crashes');
  assert.match(none.message, /\.phantom\/crashes/);

  const missing = loadCrash('nope.json', repo, { now: NOW, cwd: repo });
  assert.equal(missing.reason, 'not-found');
  assert.match(missing.hint, /--list/);

  const dir = crashDirOf(repo, '.phantom/reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'garbage.json'), 'not json at all');
  const garbage = loadCrash('.phantom/crashes/garbage.json', repo, { now: NOW, cwd: repo });
  assert.equal(garbage.reason, 'invalid');
  assert.match(garbage.message, /unreadable/);

  // slug is joined into a filename by runRecovery, so a capture carrying path
  // segments would write outside the repository phantom is allowed to touch.
  saveCrash(repo, makeCtx(repo, config, { slug: '../../../../tmp/escape' }), 'traversal.json');
  const traversal = loadCrash('.phantom/crashes/traversal.json', repo, { now: NOW, cwd: repo });
  assert.equal(traversal.reason, 'invalid');
  assert.match(traversal.message, /slug/);

  // args is spread into a spawn: a string there becomes one argument per character.
  saveCrash(repo, makeCtx(repo, config, { args: 'app.js' }), 'badargs.json');
  const badArgs = loadCrash('.phantom/crashes/badargs.json', repo, { now: NOW, cwd: repo });
  assert.equal(badArgs.reason, 'invalid');
  assert.match(badArgs.message, /args \(not an array\)/);
});

test('loadCrash: warns about what moved since the capture without refusing it', () => {
  const repo = makeRepo();
  const config = makeConfig();
  const ctx = makeCtx(repo, config, { capturedAt: daysAgo(2) });
  saveCrash(repo, ctx);
  // The user carried on: a new commit, on a different branch.
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
  sh(repo, ['commit', '-qam', 'moved on']);
  sh(repo, ['checkout', '-q', '-b', 'feature']);

  const res = loadCrash(null, repo, { now: NOW });
  assert.equal(res.ok, true, res.message);
  const warnings = res.warnings.join(' | ');
  assert.match(warnings, /HEAD is [0-9a-f]{10}/);
  assert.match(warnings, /captured on main but you are on feature/);
  // runRecovery checks out ctx.git.branch when it finishes, not the branch the
  // user was on -- worth saying out loud before it happens.
  assert.match(warnings, /put you back on main/);
  assert.match(warnings, /this capture is from 2d ago/);
});

test('runReplay: loads the newest crash and hands it to recovery unchanged', async () => {
  const repo = makeRepo();
  const config = makeConfig();
  const ctx = makeCtx(repo, config);
  const file = saveCrash(repo, ctx);
  let seen = null;

  const { result: res, out } = await withOutput(() => runReplay([], {
    cwd: repo, config, flags: { dryRun: true }, now: NOW,
    recovery: { runRecovery: async (c, cfg, flags) => { seen = { c, cfg, flags }; return { status: 'dry-run', message: 'nothing changed', branch: null }; } },
  }));

  assert.ok(seen, 'recovery ran');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.testCommand;
  assert.deepEqual(seen.c, saved, 'the saved context, untouched apart from the stripped test command');
  assert.equal(seen.cfg, config);
  assert.equal(seen.flags.dryRun, true, 'phantom flags reach the recovery');
  assert.equal(res.status, 'dry-run');
  assert.equal(res.exitCode, 0);
  assert.equal(res.crashPath, file);
  assert.match(out, /replaying/);
  assert.match(out, /20260821-120000-typeerror-cannot-read-properties\.json/);
  assert.match(out, /node app\.js — exit code 1/);
});

test('runReplay: exit code says whether the replay achieved anything', async () => {
  const repo = makeRepo();
  const config = makeConfig();
  saveCrash(repo, makeCtx(repo, config));
  const replay = (status, extra) => runReplay([], {
    cwd: repo, config, now: NOW,
    recovery: { runRecovery: async () => ({ status, message: 'm', ...extra }) },
  });

  assert.equal((await replay('fixed')).exitCode, 0);
  assert.equal((await replay('unfixed')).exitCode, 1, 'a replay that fixed nothing is a failure to whatever called it');
  assert.equal((await replay('refused')).exitCode, 1);

  // A refusal from inside runRecovery has no banner, so the CLI would print
  // nothing at all about it unless the message is repeated here.
  const { out } = await withOutput(() => replay('refused'));
  assert.match(out, /refused: m/);
  const { out: bannered } = await withOutput(() => replay('unfixed'));
  assert.doesNotMatch(bannered, /unfixed: m/, 'the recovery banner already said it');
  const { out: reported } = await withOutput(() => replay('error', { reported: true }));
  assert.doesNotMatch(reported, /error: m/, 'and a message already reported is not repeated');
});

test('runReplay: --list shows what can be replayed and starts no recovery', async () => {
  const repo = makeRepo();
  const config = makeConfig();
  saveCrash(repo, makeCtx(repo, config, { capturedAt: daysAgo(2) }), 'older.json');
  saveCrash(repo, makeCtx(repo, config), 'newest.json');
  const recovery = { runRecovery: async () => { throw new Error('must not run'); } };

  const { result: res, out } = await withOutput(() => runReplay([], { cwd: repo, config, flags: { list: true }, now: NOW, recovery }));
  assert.equal(res.status, 'listed');
  assert.equal(res.exitCode, 0);
  assert.equal(res.crashes.length, 2);
  assert.match(out, /2 saved crashes in \.phantom\/crashes, newest first/);
  assert.ok(out.indexOf('newest.json') < out.indexOf('older.json'), out);
  assert.match(out, /node app\.js — exit code 1/);
  assert.match(out, /phantom recover <file>/);

  const empty = await withOutput(() => runReplay([], { cwd: makeRepo(), config, flags: { list: true }, now: NOW, recovery }));
  assert.equal(empty.result.exitCode, 0, 'an empty list is not an error');
  assert.match(empty.out, /no saved crashes in \.phantom\/crashes/);

  const both = await withOutput(() => runReplay(['x.json'], { cwd: repo, config, flags: { list: true }, now: NOW, recovery }));
  assert.equal(both.result.reason, 'usage');
  assert.match(both.out, /--list lists the saved crashes/);
});

test('runReplay: refusals report themselves and never reach recovery', async () => {
  const repo = makeRepo();
  const config = makeConfig();
  const recovery = { runRecovery: async () => { throw new Error('must not run'); } };
  const run = (argv, extra) => withOutput(() => runReplay(argv, { cwd: repo, config, now: NOW, recovery, ...extra }));

  const none = await run([]);
  assert.equal(none.result.exitCode, 1);
  assert.equal(none.result.reason, 'no-crashes');
  assert.equal(none.result.reported, true, 'the CLI must not print the same sentence again');
  assert.match(none.out, /no saved crashes/);

  saveCrash(repo, makeCtx(repo, config));
  const trailing = await run(['crash.json', '--dry-run']);
  assert.equal(trailing.result.reason, 'usage');
  assert.match(trailing.out, /flags go first/);

  const disabled = await run([], { config: null });
  assert.equal(disabled.result.reason, 'disabled');
  assert.match(disabled.out, /PHANTOM_DISABLED/);

  const nogit = await withOutput(() => runReplay([], {
    cwd: fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'phantom-replay-nogit-')),
    config, now: NOW, recovery,
  }));
  assert.equal(nogit.result.reason, 'not-a-repo');
  assert.match(nogit.out, /not a git repository/);
});

test('runReplay: a recovery that blows up is reported, not thrown', async () => {
  const repo = makeRepo();
  const config = makeConfig();
  saveCrash(repo, makeCtx(repo, config));

  const { result: res, out } = await withOutput(() => runReplay([], {
    cwd: repo, config, now: NOW,
    recovery: { runRecovery: async () => { throw new Error('recovery blew up'); } },
  }));
  assert.equal(res.status, 'error');
  assert.equal(res.exitCode, 1);
  assert.match(out, /recovery failed: Error: recovery blew up/);
});

test('a planted capture cannot make phantom run a command of its choosing', () => {
  // A crash context used to be a file phantom WROTE. `phantom recover` makes it
  // a file phantom READS, and a repository can ship one. Two fields are
  // executed downstream: ctx.testCommand, which resolveTestCommand returns
  // verbatim when config sets none and runTests runs with `shell: true`, and
  // ctx.command/args, which reproduce() re-spawns. Validating the schema is not
  // enough when the values themselves are the payload.
  const repo = makeRepo();
  const config = makeConfig();
  const evil = makeCtx(repo, config);
  evil.testCommand = 'touch /tmp/phantom-should-never-exist; echo pwned';
  saveCrash(repo, evil, 'evil.json');

  const res = loadCrash(null, repo, { now: NOW });
  assert.equal(res.ok, true, 'the capture is otherwise valid, so it loads');
  assert.equal(res.ctx.testCommand, undefined,
    'but the shell string it named is gone: a saved file does not choose what runs');
  // Phantom can always resolve a test command locally, so nothing is lost.
  assert.ok(!JSON.stringify(res.ctx).includes('phantom-should-never-exist'));
});

test('git.root must be absolute, or the wrong-repo check can be sidestepped', () => {
  // A relative root like "." resolves against the cwd, so it matched the
  // sameness check from whatever repository the user happened to be standing
  // in -- defeating the one guard that stops a capture from another checkout
  // being replayed here.
  const repo = makeRepo();
  const config = makeConfig();
  for (const root of ['.', './', 'relative/path', '']) {
    const ctx = makeCtx(repo, config);
    ctx.git.root = root;
    saveCrash(repo, ctx, 'rel.json');
    const res = loadCrash('.phantom/crashes/rel.json', repo, { now: NOW, cwd: repo });
    assert.equal(res.ok, false, JSON.stringify(root) + ' should be refused');
    assert.match(res.message, /git\.root/);
  }
});

test('a malformed args array is refused, not thrown out of the validator', () => {
  // The element check must be guarded on isArray: calling .some() on a string
  // throws out of schemaProblem instead of rejecting the file, which would take
  // `phantom recover --list` down with it rather than labelling one bad entry.
  const repo = makeRepo();
  const config = makeConfig();
  for (const args of ['not-an-array', [1, 2], [{}], [null]]) {
    const ctx = makeCtx(repo, config);
    ctx.args = args;
    saveCrash(repo, ctx, 'args.json');
    const res = loadCrash('.phantom/crashes/args.json', repo, { now: NOW, cwd: repo });
    assert.equal(res.ok, false, JSON.stringify(args) + ' should be refused');
    assert.match(res.message, /args/);
  }
});
