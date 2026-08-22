'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');

const manage = require('../src/manage');
const ui = require('../src/ui');

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpRepo() {
  // realpathSync.native, not realpathSync: on Windows os.tmpdir() reads TEMP,
  // which is an 8.3 short name (C:\Users\RUNNER~1\...). Only the native call
  // expands it to the long form git and every other canonical path report, so
  // without it the fixture path is not string-comparable with git.root().
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'phantom-manage-'));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.name', 'Test');
  g(dir, 'config', 'user.email', 'test@example.com');
  // Git for Windows ships core.autocrlf=true in its system config, which
  // rewrites LF to CRLF on checkout. The fixtures assert on file contents and
  // sizes, so pin the line endings instead.
  g(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  return dir;
}

function g(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
}

/** A fix branch with one commit, back-dated so age filters have something to bite on. */
function fixBranch(dir, name, subject, ageDays = 0) {
  const when = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  g(dir, 'checkout', '-q', '-b', name);
  fs.writeFileSync(path.join(dir, name.replace(/[^a-z0-9]/gi, '_') + '.js'), 'ok\n');
  g(dir, 'add', '-A');
  execFileSync('git', ['commit', '-qm', subject], {
    cwd: dir, stdio: 'pipe',
    env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
  });
  g(dir, 'checkout', '-q', 'main');
  return name;
}

function stamp(ageDays) {
  const d = new Date(Date.now() - ageDays * DAY_MS);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function writeCrash(dir, slug, ageDays, body = {}) {
  const file = path.join(dir, '.phantom', 'crashes', stamp(ageDays) + '-' + slug + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ commandLine: 'npm run dev', errorLine: 'TypeError: boom', exitCode: 1, ...body }, null, 2));
  return file;
}

function writeReport(dir, slug, ageDays, summary = 'npm run dev (exit 1)') {
  const file = path.join(dir, '.phantom', 'reports', stamp(ageDays) + '-' + slug + '.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# 👻 Phantom post-mortem — ' + summary + '\n\n## TL;DR\nfixed\n');
  return file;
}

const capture = () => {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  s.text = () => text;
  return s;
};

/** Run `fn` with phantom's own log output captured and colour forced off. */
async function quiet(fn) {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  const logged = capture();
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
  ui.setStream(logged);
  try {
    return await fn(logged);
  } finally {
    ui.setStream(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const names = (list) => list.map((e) => e.name);
const branch = (state, name) => state.branches.find((b) => b.name === name);

test('listPhantomState reports crashes, reports and fix branches newest first', () => {
  const dir = tmpRepo();
  writeCrash(dir, 'old-one', 40);
  writeCrash(dir, 'new-one', 1);
  writeReport(dir, 'old-one', 40, 'node server.js (exit 1)');
  writeReport(dir, 'new-one', 1);
  const merged = fixBranch(dir, 'phantom/fix-merged-aaa11', 'phantom: fix TypeError: boom', 3);
  g(dir, 'merge', '-q', '--no-edit', merged);
  const open = fixBranch(dir, 'phantom/fix-open-bbb22', 'phantom: WIP (unfixed) ENOENT', 1);
  // A branch outside the namespace must never even be listed.
  g(dir, 'branch', 'feature/unrelated');

  const state = manage.listPhantomState(dir);
  assert.equal(state.root, dir);
  assert.equal(state.currentBranch, 'main');
  assert.deepEqual(state.crashes.map((c) => c.slug), ['new-one', 'old-one'], 'newest first');
  assert.deepEqual(state.reports.map((r) => r.slug), ['new-one', 'old-one']);
  assert.deepEqual(names(state.branches), [open, merged], 'newest tip first, and only phantom/fix-*');

  assert.equal(branch(state, merged).merged, true);
  assert.equal(branch(state, merged).subject, 'phantom: fix TypeError: boom');
  assert.match(branch(state, merged).shortSha, /^[0-9a-f]{8}$/);
  assert.equal(branch(state, open).merged, false, 'not reachable from main');
  assert.ok(branch(state, open).ageDays >= 0.9 && branch(state, open).ageDays < 1.2, 'age comes from the tip commit date');

  const newest = state.crashes[0];
  assert.equal(newest.detail.command, 'npm run dev');
  assert.equal(newest.detail.errorLine, 'TypeError: boom');
  assert.equal(newest.rel, '.phantom/crashes/' + newest.name);
  assert.ok(newest.bytes > 0);
  assert.ok(newest.ageDays >= 0.9 && newest.ageDays < 1.2, 'age comes from the filename timestamp');
  assert.equal(state.reports[1].detail.title, 'node server.js (exit 1)', 'the shared post-mortem boilerplate is stripped');
  assert.equal(state.totals.crashBytes, state.crashes.reduce((n, c) => n + c.bytes, 0));
});

test('an oversized crash capture is still listed, just not parsed into memory', () => {
  // Each crash JSON carries the whole output tail (up to ringBufferBytes, 64 MB
  // at the ceiling). Reading one only buys a prettier `ls` row.
  const dir = tmpRepo();
  writeCrash(dir, 'huge', 2, { tail: 'x'.repeat(200000) });
  const state = manage.listPhantomState(dir, { maxParseBytes: 1024 });
  assert.equal(state.crashes.length, 1);
  assert.equal(state.crashes[0].detail, null, 'not parsed');
  assert.equal(state.crashes[0].slug, 'huge', 'but still identified, aged and sized from the filename');
  assert.ok(state.crashes[0].bytes > 200000);
  assert.ok(state.crashes[0].ageDays > 1.9);
});

test('a repo with no phantom history lists cleanly instead of throwing', () => {
  const dir = tmpRepo();
  const state = manage.listPhantomState(dir);
  assert.deepEqual([state.crashes, state.reports, state.branches], [[], [], []]);
  assert.equal(state.totals.crashBytes, 0);
});

test('by default planClean selects merged fix branches and nothing else', () => {
  const dir = tmpRepo();
  writeCrash(dir, 'old', 90);
  writeReport(dir, 'old', 90);
  const merged = fixBranch(dir, 'phantom/fix-merged-aaa11', 'phantom: fix boom', 5);
  g(dir, 'merge', '-q', '--no-edit', merged);
  const open = fixBranch(dir, 'phantom/fix-open-bbb22', 'phantom: WIP', 5);
  g(dir, 'branch', 'feature/unrelated');

  const plan = manage.planClean(manage.listPhantomState(dir));
  assert.deepEqual(names(plan.deletions), [merged]);
  assert.equal(plan.counts.branches, 1);
  assert.equal(plan.counts.crashes, 0);
  assert.equal(plan.counts.reports, 0, 'keepReports already prunes files by count; do not double up on it');
  assert.equal(plan.unmergedSelected, 0);

  const keptOpen = plan.kept.find((k) => k.name === open);
  assert.match(keptOpen.reason, /not merged into main/);
  assert.ok(plan.kept.some((k) => k.kind === 'crash' && /keepReports/.test(k.reason)));
  assert.ok(plan.reasons.some((r) => /only those already merged into main/.test(r)));
});

test('the branch you are standing on is never selected, even when it is a fix branch', () => {
  const dir = tmpRepo();
  const b = fixBranch(dir, 'phantom/fix-here-ccc33', 'phantom: fix', 1);
  g(dir, 'checkout', '-q', b);
  const state = manage.listPhantomState(dir);
  assert.equal(branch(state, b).current, true);
  assert.equal(branch(state, b).merged, true, 'HEAD is always merged into HEAD');
  const plan = manage.planClean(state);
  assert.deepEqual(plan.deletions, []);
  assert.match(plan.kept.find((k) => k.name === b).reason, /you are on this branch/);
});

test('--unmerged is the only way an unmerged fix branch is ever selected', () => {
  const dir = tmpRepo();
  const open = fixBranch(dir, 'phantom/fix-open-bbb22', 'phantom: WIP', 1);
  assert.deepEqual(manage.planClean(manage.listPhantomState(dir)).deletions, []);
  const plan = manage.planClean(manage.listPhantomState(dir), { unmerged: true });
  assert.deepEqual(names(plan.deletions), [open]);
  assert.equal(plan.unmergedSelected, 1, 'the renderer needs this to warn about the reflog');
  assert.match(plan.deletions[0].reason, /--unmerged/);
});

test('--older-than filters branches by tip date and files by their timestamp', () => {
  const dir = tmpRepo();
  const oldCrash = writeCrash(dir, 'ancient', 90);
  writeCrash(dir, 'fresh', 2);
  const oldReport = writeReport(dir, 'ancient', 90);
  writeReport(dir, 'fresh', 2);
  const oldBranch = fixBranch(dir, 'phantom/fix-ancient-aaa11', 'phantom: fix old', 90);
  g(dir, 'merge', '-q', '--no-edit', oldBranch);
  const newBranch = fixBranch(dir, 'phantom/fix-fresh-bbb22', 'phantom: fix new', 2);
  g(dir, 'merge', '-q', '--no-edit', newBranch);

  const state = manage.listPhantomState(dir);
  const plan = manage.planClean(state, { olderThanDays: 30 });
  assert.deepEqual(plan.deletions.map((d) => d.file || d.name).sort(), [oldBranch, oldCrash, oldReport].sort());
  assert.ok(plan.kept.some((k) => k.name === newBranch && /newer than 30/.test(k.reason)));
  assert.equal(plan.counts.bytes, fs.statSync(oldCrash).size + fs.statSync(oldReport).size);

  // --all drops the age filter for files but leaves the merged-only rule alone.
  const allPlan = manage.planClean(state, { all: true });
  assert.equal(allPlan.counts.crashes, 2);
  assert.equal(allPlan.counts.reports, 2);
  assert.equal(allPlan.counts.branches, 2);
});

test('--branches and --files scope the plan to one kind', () => {
  const dir = tmpRepo();
  writeCrash(dir, 'old', 90);
  const b = fixBranch(dir, 'phantom/fix-old-aaa11', 'phantom: fix', 90);
  g(dir, 'merge', '-q', '--no-edit', b);
  const state = manage.listPhantomState(dir);
  assert.deepEqual(names(manage.planClean(state, { olderThanDays: 30, files: false }).deletions), [b]);
  const filesOnly = manage.planClean(state, { olderThanDays: 30, branches: false });
  assert.equal(filesOnly.counts.branches, 0);
  assert.equal(filesOnly.counts.crashes, 1);
});

test('planClean refuses names and paths outside the namespace it owns', () => {
  const dir = tmpRepo();
  // A branch under the prefix that phantom itself could never have produced:
  // an extra path segment escapes `phantom/fix-<slug>`.
  const odd = 'phantom/fix-x/../../evil';
  const state = manage.listPhantomState(dir);
  state.branches.push({ kind: 'branch', name: odd, sha: 'a'.repeat(40), shortSha: 'aaaaaaaa', subject: '', at: new Date().toISOString(), ageDays: 0, merged: true, current: false });
  state.crashes.push({ kind: 'crash', name: 'evil.json', file: path.join(dir, 'evil.json'), rel: 'evil.json', bytes: 1, at: new Date(0).toISOString(), ageDays: 9999, slug: 'evil', detail: null });

  const plan = manage.planClean(state, { olderThanDays: 1 });
  assert.deepEqual(plan.deletions, [], 'neither is selected');
  assert.match(plan.kept.find((k) => k.name === odd).reason, /outside the phantom\/fix-<slug> shape/);
  assert.match(plan.kept.find((k) => k.name === 'evil.json').reason, /outside \.phantom\//);
});

test('applyClean deletes what the plan named and nothing else', async () => {
  const dir = tmpRepo();
  const crash = writeCrash(dir, 'old', 90);
  const report = writeReport(dir, 'old', 90);
  const keptCrash = writeCrash(dir, 'fresh', 1);
  const merged = fixBranch(dir, 'phantom/fix-merged-aaa11', 'phantom: fix', 90);
  g(dir, 'merge', '-q', '--no-edit', merged);
  const open = fixBranch(dir, 'phantom/fix-open-bbb22', 'phantom: WIP', 90);
  g(dir, 'branch', 'feature/unrelated');

  const state = manage.listPhantomState(dir);
  const plan = manage.planClean(state, { olderThanDays: 30 });
  const results = manage.applyClean(plan, { cwd: dir, state });

  assert.deepEqual(results.failed, []);
  assert.equal(results.counts.branches, 1);
  assert.equal(results.counts.crashes, 1);
  assert.equal(results.counts.reports, 1);
  assert.ok(results.counts.bytes > 0);
  assert.equal(fs.existsSync(crash), false);
  assert.equal(fs.existsSync(report), false);
  assert.equal(fs.existsSync(keptCrash), true, 'the young capture survives');

  const left = g(dir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
  assert.deepEqual(left, ['feature/unrelated', 'main', open].sort(), 'unmerged and unrelated branches survive');

  // The sha is reported so the deletion is undoable.
  const deletedBranch = results.deleted.find((d) => d.kind === 'branch');
  assert.match(deletedBranch.shortSha, /^[0-9a-f]{8}$/);
  g(dir, 'branch', merged, deletedBranch.sha);
  assert.equal(g(dir, 'rev-parse', merged).trim(), deletedBranch.sha);
});

test('applyClean re-checks every entry, so a stale or hand-built plan cannot escape', () => {
  const dir = tmpRepo();
  const b = fixBranch(dir, 'phantom/fix-stale-aaa11', 'phantom: fix', 1);
  g(dir, 'merge', '-q', '--no-edit', b);
  const state = manage.listPhantomState(dir);
  const plan = manage.planClean(state);
  assert.equal(plan.counts.branches, 1);

  // The world moved between plan and apply: the branch got a commit of its own
  // and is no longer merged. `git branch -d` is what notices.
  g(dir, 'checkout', '-q', b);
  fs.writeFileSync(path.join(dir, 'later.js'), 'x\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'work after the plan was made');
  g(dir, 'checkout', '-q', 'main');

  const results = manage.applyClean(plan, { cwd: dir, state });
  assert.deepEqual(results.deleted, []);
  assert.equal(results.failed.length, 1);
  assert.match(results.failed[0].error, /git refused/);
  assert.match(g(dir, 'branch', '--format=%(refname:short)'), new RegExp(b.replace('/', '\\/')));

  // And a plan that names something outside .phantom/ is refused at the last moment.
  const outside = path.join(dir, 'a.txt');
  const evil = { deletions: [{ kind: 'crash', name: 'a.txt', file: outside, rel: 'a.txt', bytes: 4 }], counts: {}, kept: [], reasons: [], root: dir };
  const evilResults = manage.applyClean(evil, { cwd: dir, state });
  assert.equal(evilResults.deleted.length, 0);
  assert.match(evilResults.failed[0].error, /refused: outside/);
  assert.equal(fs.existsSync(outside), true, "the user's own file is untouched");
});

test('applyClean will not delete the branch you are standing on', () => {
  const dir = tmpRepo();
  const b = fixBranch(dir, 'phantom/fix-here-ccc33', 'phantom: fix', 1);
  g(dir, 'merge', '-q', '--no-edit', b);
  const state = manage.listPhantomState(dir);
  const plan = manage.planClean(state);
  assert.equal(plan.counts.branches, 1);
  g(dir, 'checkout', '-q', b); // the user switched to it after planning
  const results = manage.applyClean(plan, { cwd: dir, state });
  assert.deepEqual(results.deleted, []);
  assert.match(results.failed[0].error, /current branch/);
});

test('runClean prints the plan and deletes nothing without a confirmation', async () => {
  const dir = tmpRepo();
  const b = fixBranch(dir, 'phantom/fix-merged-aaa11', 'phantom: fix TypeError', 1);
  g(dir, 'merge', '-q', '--no-edit', b);

  await quiet(async () => {
    const out = capture();
    const code = await manage.runClean([], { cwd: dir, out, ask: async () => 'n' });
    assert.equal(code, 1, 'the user asked for a deletion that did not happen');
    assert.match(out.text(), /would delete:/);
    assert.match(out.text(), new RegExp(b.replace('/', '\\/')));
    assert.equal(manage.listPhantomState(dir).branches.length, 1, 'still there');

    // No answer available at all (a pipe, CI, the timeout) is also "do nothing".
    const out2 = capture();
    assert.equal(await manage.runClean([], { cwd: dir, out: out2, ask: async () => null }), 1);
    assert.equal(manage.listPhantomState(dir).branches.length, 1);

    // --dry-run is a clean exit: the user asked to be shown, and was shown.
    const out3 = capture();
    let asked = false;
    assert.equal(await manage.runClean(['--dry-run'], { cwd: dir, out: out3, ask: async () => { asked = true; return 'y'; } }), 0);
    assert.equal(asked, false, '--dry-run never prompts');
    assert.equal(manage.listPhantomState(dir).branches.length, 1);

    const out4 = capture();
    assert.equal(await manage.runClean([], { cwd: dir, out: out4, ask: async () => 'y' }), 0);
    assert.equal(manage.listPhantomState(dir).branches.length, 0, 'confirmed, so it went');
  });
});

test('--yes skips the prompt; nothing else does', async () => {
  const dir = tmpRepo();
  const b = fixBranch(dir, 'phantom/fix-merged-aaa11', 'phantom: fix', 1);
  g(dir, 'merge', '-q', '--no-edit', b);
  await quiet(async () => {
    let asked = false;
    const code = await manage.runClean(['--yes'], { cwd: dir, out: capture(), ask: async () => { asked = true; return 'y'; } });
    assert.equal(code, 0);
    assert.equal(asked, false);
    assert.equal(manage.listPhantomState(dir).branches.length, 0);
  });
});

test('runClean warns loudly before deleting unmerged branches', async () => {
  const dir = tmpRepo();
  const open = fixBranch(dir, 'phantom/fix-open-bbb22', 'phantom: WIP', 1);
  await quiet(async () => {
    const out = capture();
    const code = await manage.runClean(['--unmerged', '--yes'], { cwd: dir, out, ask: async () => 'y' });
    assert.equal(code, 0);
    assert.match(out.text(), /UNMERGED/);
    assert.match(out.text(), /reflog/, 'the user is told where the commits went');
    assert.equal(manage.listPhantomState(dir).branches.length, 0);
    assert.equal(open.startsWith('phantom/fix-'), true);
  });
});

test('runClean on a repo with nothing to prune says so and exits 0', async () => {
  const dir = tmpRepo();
  await quiet(async () => {
    const out = capture();
    let asked = false;
    assert.equal(await manage.runClean([], { cwd: dir, out, ask: async () => { asked = true; return 'y'; } }), 0);
    assert.equal(asked, false, 'no confirmation for a no-op');
    assert.match(out.text(), /nothing to delete/);
  });
});

test('runList renders every section, newest first, and honours --limit', async () => {
  const dir = tmpRepo();
  writeCrash(dir, 'older-crash', 40);
  writeCrash(dir, 'newer-crash', 1);
  writeReport(dir, 'only-report', 1, 'npm test (exit 1)');
  const merged = fixBranch(dir, 'phantom/fix-merged-aaa11', 'phantom: fix TypeError: boom', 3);
  g(dir, 'merge', '-q', '--no-edit', merged);
  fixBranch(dir, 'phantom/fix-open-bbb22', 'phantom: WIP (unfixed) ENOENT', 1);

  await quiet(async () => {
    // isTTY, explicitly: this is the aligned human view, and which view `ls`
    // renders now depends on the destination. Left to the default the assertions
    // below would pass or fail according to whether the developer running the
    // suite had a terminal attached.
    const out = capture();
    out.isTTY = true;
    assert.equal(await manage.runList([], { cwd: dir, out }), 0);
    const text = out.text();
    assert.match(text, /fix branches \(2\)/);
    assert.match(text, /crash captures \(2 · /);
    assert.match(text, /post-mortems \(1 · /);
    assert.match(text, /phantom\/fix-open-bbb22 +1d ago +unmerged +phantom: WIP \(unfixed\) ENOENT/);
    assert.match(text, /phantom\/fix-merged-aaa11 +3d ago +merged +phantom: fix TypeError: boom/);
    assert.ok(text.indexOf('phantom/fix-open-bbb22') < text.indexOf('phantom/fix-merged-aaa11'), 'newest branch first');
    assert.ok(text.indexOf('newer-crash') === -1, 'the crash row shows the command and error, not the slug');
    assert.match(text, /npm run dev — TypeError: boom/);
    assert.match(text, /npm test \(exit 1\)/, 'the post-mortem summary, without the shared boilerplate');
    assert.match(text, /keepReports=50 prunes/, 'says what is already automatic');
    assert.match(text, /phantom clean --merged would delete 1 merged fix branch/);
    assert.match(text, /\(on main\)/);

    const limited = capture();
    limited.isTTY = true;
    await manage.runList(['--limit', '1'], { cwd: dir, out: limited });
    assert.match(limited.text(), /… 1 more/);
    assert.equal(limited.text().includes('phantom/fix-merged-aaa11'), false, 'trimmed to the newest');
  });
});

test('ls and clean outside a git repo fail with a usage exit code, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-norepo-'));
  await quiet(async (logged) => {
    assert.equal(await manage.runList([], { cwd: dir, out: capture() }), 2);
    assert.equal(await manage.runClean(['--yes'], { cwd: dir, out: capture() }), 2);
    assert.match(logged.text(), /not a git repository/);
  });
});

test('argument parsing rejects the contradictory and the unknown', async () => {
  assert.deepEqual(manage.parseManageArgs('clean', ['--older-than=30']).olderThanDays, 30);
  assert.equal(manage.parseManageArgs('clean', ['--older-than', '7']).olderThanDays, 7);
  assert.equal(manage.parseManageArgs('clean', ['--branches']).files, false);
  assert.equal(manage.parseManageArgs('ls', ['-h']).help, true);
  assert.throws(() => manage.parseManageArgs('clean', ['--merged', '--unmerged']), /contradict/);
  assert.throws(() => manage.parseManageArgs('clean', ['--older-than', 'soon']), /number of days|non-negative number/);
  assert.throws(() => manage.parseManageArgs('clean', ['--older-than']), /requires a value/);
  assert.throws(() => manage.parseManageArgs('ls', ['--nope']), /unknown option --nope/);

  await quiet(async (logged) => {
    assert.equal(await manage.runClean(['--nope'], { cwd: process.cwd(), out: capture() }), 2);
    assert.match(logged.text(), /unknown option --nope/);
  });
});

test('--help prints usage and touches nothing', async () => {
  const dir = tmpRepo();
  const b = fixBranch(dir, 'phantom/fix-merged-aaa11', 'phantom: fix', 1);
  g(dir, 'merge', '-q', '--no-edit', b);
  await quiet(async () => {
    const out = capture();
    assert.equal(await manage.runSubcommand('clean', ['--help'], { cwd: dir, out, ask: async () => 'y' }), 0);
    assert.match(out.text(), /Usage: phantom clean/);
    assert.match(out.text(), /--older-than/);
    assert.equal(manage.listPhantomState(dir).branches.length, 1);

    const lsOut = capture();
    assert.equal(await manage.runSubcommand('ls', ['--help'], { cwd: dir, out: lsOut }), 0);
    assert.match(lsOut.text(), /Usage: phantom ls/);
    assert.match(lsOut.text(), /phantom -- ls/, 'the escape hatch for wrapping the real ls');
  });
});

test('a tag that shadows a fix branch does not hide it', () => {
  // `%(refname:short)` is ambiguity-aware: with a tag of the same name it
  // reports `heads/phantom/fix-x`, which matches neither the current branch nor
  // the safe-name rule -- so the branch would silently drop out of `ls` and out
  // of every plan, and never be cleaned.
  const dir = tmpRepo();
  const b = fixBranch(dir, 'phantom/fix-shadowed-aaa11', 'phantom: fix', 1);
  g(dir, 'merge', '-q', '--no-edit', b);
  g(dir, 'tag', b);

  const state = manage.listPhantomState(dir);
  assert.deepEqual(names(state.branches), [b], 'the real branch name, not heads/…');
  const plan = manage.planClean(state);
  assert.deepEqual(names(plan.deletions), [b]);
  assert.deepEqual(manage.applyClean(plan, { cwd: dir, state }).failed, []);
  assert.equal(manage.listPhantomState(dir).branches.length, 0);
  assert.equal(g(dir, 'tag', '-l').trim(), b, 'the tag is left alone');
});

test('isSubcommand recognises exactly ls and clean', () => {
  assert.equal(manage.isSubcommand('ls'), true);
  assert.equal(manage.isSubcommand('clean'), true);
  assert.equal(manage.isSubcommand('npm'), false);
  assert.equal(manage.isSubcommand('--'), false, 'so `phantom -- ls -la` still wraps the real ls');
  assert.equal(manage.isSubcommand(undefined), false);
});

test('a custom reportDir is followed for both directories', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ reportDir: 'ghosts/reports', keepReports: 5 }));
  const report = path.join(dir, 'ghosts', 'reports', stamp(1) + '-slug.md');
  const crash = path.join(dir, 'ghosts', 'crashes', stamp(1) + '-slug.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.mkdirSync(path.dirname(crash), { recursive: true });
  fs.writeFileSync(report, '# 👻 Phantom post-mortem — npm test (exit 1)\n');
  fs.writeFileSync(crash, '{}');

  const state = manage.listPhantomState(dir, { reportDir: 'ghosts/reports', keepReports: 5 });
  assert.equal(state.crashes.length, 1);
  assert.equal(state.reports.length, 1);
  assert.equal(state.phantomDir, path.join(dir, 'ghosts'));
  const plan = manage.planClean(state, { all: true });
  assert.equal(plan.counts.crashes + plan.counts.reports, 2);
  assert.equal(manage.applyClean(plan, { cwd: dir, state }).failed.length, 0, 'the guard follows reportDir, it does not hardcode .phantom');
  assert.equal(fs.existsSync(crash), false);
});

test('a symlinked reports directory cannot make clean delete outside the repo', () => {
  // The "inside .phantom/" boundary was computed lexically with path.relative,
  // and unlink() follows symlinks. A repo shipping `.phantom/reports ->
  // ../outside` produced entries whose lexical path was
  // `.phantom/reports/x.md` -- passing the check in both planClean and
  // applyClean -- while the unlink resolved through the link and deleted the
  // real file outside. Lexical containment is not containment when the
  // filesystem can redirect you.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-outside-'));
  const victim = path.join(outside, '20200101-000000-victim.md');
  fs.writeFileSync(victim, 'PRECIOUS DATA\n');

  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, '.phantom'), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, '.phantom', 'reports'), 'dir');

  const state = manage.listPhantomState(repo, { now: Date.now() });
  const plan = manage.planClean(state, { all: true });
  const applied = manage.applyClean(plan, { cwd: repo });

  assert.equal(fs.readFileSync(victim, 'utf8'), 'PRECIOUS DATA\n', 'the file outside survives');
  assert.equal(applied.counts.reports, 0, 'and nothing outside was counted as deleted');
  assert.ok(!plan.deletions.some((d) => d.kind === 'report'),
    'the plan does not even offer it: ' + JSON.stringify(plan.deletions.map((d) => d.rel)));
});

test('a real reports directory still cleans, so the symlink guard is not over-tight', () => {
  // The control for the test above: refusing everything would "fix" the symlink
  // escape and break the feature.
  const repo = tmpRepo();
  const reports = path.join(repo, '.phantom', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, '20200101-000000-real.md'), 'old\n');

  const state = manage.listPhantomState(repo, { now: Date.now() });
  const plan = manage.planClean(state, { all: true });
  const applied = manage.applyClean(plan, { cwd: repo });

  assert.equal(applied.counts.reports, 1, 'an ordinary report inside .phantom/ is still removed');
  assert.ok(!fs.existsSync(path.join(reports, '20200101-000000-real.md')));
});
