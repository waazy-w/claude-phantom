'use strict';

/**
 * The end-of-recovery prompt: "merge into main, delete it, or keep it for later?"
 *
 * These run against real git repositories, because the point of the prompt is
 * that answering it moves real branches. The gating tests matter most: phantom
 * wraps commands people run in scripts, so every path that cannot safely act
 * must fall through without asking and without touching anything.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../src/git');
const ui = require('../src/ui');
const { offerBranchDecision } = require('../src/recovery');
const { Writable } = require('node:stream');

const capture = () => {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  s.text = () => text;
  return s;
};

/** A repo on `main` with a phantom fix branch holding one extra commit. */
function repoWithFix() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-decide-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.com');
  // These tests compare the file byte for byte; without this a Windows checkout
  // rewrites the LF the test wrote to CRLF and every comparison drifts.
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = () => 1;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const baseSha = git.headSha({ cwd: dir });

  g('checkout', '-q', '-b', 'phantom/fix-x');
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = () => 2;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'phantom: fix');
  g('checkout', '-q', 'main');
  return { dir, baseSha };
}

/** The shape offerBranchDecision expects, for a clean successful recovery. */
function scenario(dir, baseSha, over = {}) {
  return {
    final: { status: 'fixed', branch: 'phantom/fix-x', ...over.final },
    ctx: { git: { branch: 'main' } },
    s: { baseSha, stayed: false, stashed: false, onPhantomBranch: false, ...over.s },
    config: { promptOnFinish: true, ...over.config },
    flags: { dryRun: false, noPrompt: false, ...over.flags },
    opts: { cwd: dir },
  };
}

/** Records what it was asked and answers with `answer`. */
const answers = (answer) => {
  const calls = [];
  const fn = (question, opts) => { calls.push({ question, opts }); return Promise.resolve(answer); };
  fn.calls = calls;
  return fn;
};

const run = (sc, ask) => offerBranchDecision(sc.final, { ...sc, ask });

test('answering "m" merges the fix into the user\'s branch', async () => {
  const { dir, baseSha } = repoWithFix();
  const out = capture();
  ui.setStream(out);
  try {
    const ask = answers('m');
    await run(scenario(dir, baseSha), ask);
    assert.strictEqual(ask.calls.length, 1);
    assert.match(ask.calls[0].question, /merge into .*main.*delete it, or keep it/);
    // `v` (view the diff) and `a` (apply to the working tree) joined the menu:
    // looking at the change is the thing a person actually wants at this
    // moment, and `m` takes phantom's COMMIT when people usually want the
    // change to commit as their own.
    assert.deepStrictEqual(ask.calls[0].opts.keys, ['m', 'a', 'v', 'd', 'k']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'module.exports = () => 2;\n');
    assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), true, 'merging keeps the branch');
    assert.match(out.text(), /merged phantom\/fix-x into main/);
    assert.match(out.text(), new RegExp('undo with: git reset --hard ' + baseSha.slice(0, 10)));
  } finally { ui.setStream(null); }
});

test('answering "d" deletes the branch and leaves the user\'s branch alone', async () => {
  const { dir, baseSha } = repoWithFix();
  const out = capture();
  ui.setStream(out);
  try {
    await run(scenario(dir, baseSha), answers('d'));
    assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'module.exports = () => 1;\n');
    assert.strictEqual(git.headSha({ cwd: dir }), baseSha, 'main did not move');
    assert.match(out.text(), /deleted phantom\/fix-x; main is unchanged/);
  } finally { ui.setStream(null); }
});

test('"k" and an unanswerable prompt both change nothing at all', async () => {
  for (const answer of ['k', null]) {
    const { dir, baseSha } = repoWithFix();
    const out = capture();
    ui.setStream(out);
    try {
      await run(scenario(dir, baseSha), answers(answer));
      assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), true, String(answer));
      assert.strictEqual(git.headSha({ cwd: dir }), baseSha, String(answer));
      assert.strictEqual(out.text(), '', 'declining says nothing further: ' + answer);
    } finally { ui.setStream(null); }
  }
});

test('a merge conflict is reported, not unwound behind the user\'s back', async () => {
  const { dir, baseSha } = repoWithFix();
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  // Move main to a conflicting edit of the same line, then commit it clean.
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = () => 3;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'diverge');
  const out = capture();
  ui.setStream(out);
  try {
    await run(scenario(dir, git.headSha({ cwd: dir })), answers('m'));
    assert.match(out.text(), /merge did not complete cleanly/);
    assert.match(out.text(), /git merge --abort/);
    assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), true, 'the fix is still there to resolve');
  } finally {
    ui.setStream(null);
    execFileSync('git', ['merge', '--abort'], { cwd: dir, stdio: 'pipe' });
  }
  assert.ok(baseSha);
});

test('the prompt is skipped whenever acting on it would be unsafe or pointless', async () => {
  const cases = [
    ['an unfixed run has nothing to merge', { final: { status: 'unfixed' } }],
    ['a run that produced no branch', { final: { branch: null } }],
    ['--dry-run never changed anything', { flags: { dryRun: true } }],
    ['--no-prompt was passed', { flags: { noPrompt: true } }],
    ['promptOnFinish is off in config', { config: { promptOnFinish: false } }],
    ['the user was left on the phantom branch, uncommitted', { s: { stayed: true } }],
    ['a stash phantom could not pop is still outstanding', { s: { stashed: true } }],
    ['phantom never got back off its own branch', { s: { onPhantomBranch: true } }],
  ];
  for (const [why, over] of cases) {
    const { dir, baseSha } = repoWithFix();
    const ask = answers('m');
    await run(scenario(dir, baseSha, over), ask);
    assert.strictEqual(ask.calls.length, 0, 'should not have asked: ' + why);
    assert.strictEqual(git.headSha({ cwd: dir }), baseSha, why);
    assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), true, why);
  }
});

test('a dirty working tree suppresses the prompt rather than risking the merge', async () => {
  const { dir, baseSha } = repoWithFix();
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'work in progress\n');
  const ask = answers('m');
  await run(scenario(dir, baseSha), ask);
  assert.strictEqual(ask.calls.length, 0);
  assert.strictEqual(git.headSha({ cwd: dir }), baseSha);
});

test('"v" shows the diff and asks again, changing nothing', async () => {
  // The one thing a person wants at this instant is to look. Without it they
  // answered "k", scrolled back, and retyped a 46-character branch name.
  const { dir, baseSha } = repoWithFix();
  const out = capture();
  ui.setStream(out);
  try {
    // Look twice, then keep. Looking must be free and repeatable.
    const answers = ['v', 'v', 'k'];
    const calls = [];
    const ask = (question, opts) => { calls.push({ question, opts }); return Promise.resolve(answers.shift()); };
    await run(scenario(dir, baseSha), ask);

    assert.strictEqual(calls.length, 3, 'v re-asks rather than deciding');
    assert.match(out.text(), /module\.exports = \(\) => 2/, 'the diff is actually printed');
    assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), true, 'and nothing changed');
    assert.strictEqual(git.headSha({ cwd: dir }), baseSha);
  } finally { ui.setStream(null); }
});

test('"a" applies the fix to the working tree, staged and uncommitted', async () => {
  // `m` lands phantom's commit and message on the user's branch. `a` gives them
  // the change instead, to amend and commit as their own.
  const { dir, baseSha } = repoWithFix();
  const out = capture();
  ui.setStream(out);
  try {
    await run(scenario(dir, baseSha), answers('a'));

    assert.strictEqual(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'module.exports = () => 2;\n',
      'the change is in the working tree');
    assert.strictEqual(git.headSha({ cwd: dir }), baseSha, 'but no commit was made');
    assert.match(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }), /app\.js/,
      'and it is staged, ready to commit as the user\'s own');
    assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), true, 'the branch is left alone');
    assert.match(out.text(), /commit it as your own/);
    assert.match(out.text(), /undo with:/, 'and says how to back out');
  } finally { ui.setStream(null); }
});

test('a conflicting "a" reports the conflict instead of unwinding it', async () => {
  const { dir } = repoWithFix();
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = () => 3;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'diverge');
  const out = capture();
  ui.setStream(out);
  try {
    await run(scenario(dir, git.headSha({ cwd: dir })), answers('a'));
    assert.match(out.text(), /conflict/i);
    assert.match(out.text(), /back out with:/, 'the way out is printed, not guessed at');
    assert.strictEqual(git.branchExists('phantom/fix-x', { cwd: dir }), true, 'the fix is still there to resolve');
  } finally {
    ui.setStream(null);
    try { execFileSync('git', ['cherry-pick', '--abort'], { cwd: dir, stdio: 'pipe' }); } catch { /* nothing to abort */ }
  }
});
