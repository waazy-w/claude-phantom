'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../src/git');

function tmpRepo() {
  // realpathSync.native, not realpathSync: on Windows os.tmpdir() reads TEMP,
  // which is an 8.3 short name (C:\Users\RUNNER~1\...). Only the native call
  // expands it to the long form git and every other canonical path report, so
  // without it the fixture path is not string-comparable with git.root().
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'phantom-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  // Git for Windows ships core.autocrlf=true in its system config, which
  // rewrites LF to CRLF on checkout -- stash pop would hand back 'dirty\r\n'.
  // The fixture asserts on bytes, so pin the line endings instead.
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('non-repo directories return null/false instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-norepo-'));
  const cwd = { cwd: dir };
  assert.strictEqual(git.isRepo(cwd), false);
  assert.strictEqual(git.root(cwd), null);
  assert.strictEqual(git.headSha(cwd), null);
  assert.strictEqual(git.currentBranch(cwd), null);
  assert.strictEqual(git.status(cwd), null);
  assert.strictEqual(git.isDirty(cwd), false);
  assert.deepStrictEqual(git.recentCommits(5, cwd), []);
  assert.deepStrictEqual(git.changedFilesSince('HEAD', cwd), []);
  assert.strictEqual(git.commitAll('x', cwd), null);
  assert.strictEqual(git.branchExists('main', cwd), false);
});

test('read helpers on a real repo', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  assert.strictEqual(git.isRepo(cwd), true);
  assert.strictEqual(git.root(cwd), dir);
  assert.strictEqual(git.currentBranch(cwd), 'main');
  assert.match(git.headSha(cwd), /^[0-9a-f]{40}$/);
  assert.strictEqual(git.isDirty(cwd), false);
  assert.strictEqual(git.recentCommits(5, cwd).length, 1);
  assert.match(git.recentCommits(5, cwd)[0], /init$/);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  assert.strictEqual(git.isDirty(cwd), true);
  assert.match(git.status(cwd), /\?\? b\.txt/);
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  assert.strictEqual(git.root({ cwd: sub }), dir);
});

test('detached HEAD gives null branch but a sha', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const sha = git.headSha(cwd);
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir });
  assert.strictEqual(git.currentBranch(cwd), null);
  assert.strictEqual(git.headSha(cwd), sha);
});

test('branch, stash, commit, reset and clean round trip', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const base = git.headSha(cwd);

  assert.strictEqual(git.stashPush('nothing', cwd), null, 'nothing to stash reports null, not a sha');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u\n');
  const stashRef = git.stashPush('phantom-snapshot', cwd);
  assert.match(stashRef, /^[0-9a-f]{40}$/, 'stashPush returns the stash commit sha');
  assert.strictEqual(git.stashExists(stashRef, cwd), true);
  assert.strictEqual(git.isDirty(cwd), false);
  assert.ok(!fs.existsSync(path.join(dir, 'untracked.txt')));

  assert.strictEqual(git.createBranch('phantom/fix-x', cwd), true);
  assert.strictEqual(git.currentBranch(cwd), 'phantom/fix-x');
  assert.strictEqual(git.branchExists('phantom/fix-x', cwd), true);
  fs.writeFileSync(path.join(dir, 'fix.js'), 'ok\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  assert.deepStrictEqual(git.changedFilesSince(base, cwd), ['a.txt', 'fix.js']);

  const sha = git.commitAll('phantom: fix', cwd);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.notStrictEqual(sha, base);
  assert.strictEqual(git.isDirty(cwd), false);
  assert.strictEqual(git.commitAll('nothing to commit', cwd), null);

  fs.writeFileSync(path.join(dir, 'junk.txt'), 'j\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'again\n');
  assert.strictEqual(git.resetHard(base, cwd), true);
  assert.strictEqual(git.cleanUntracked(cwd), true);
  assert.strictEqual(git.headSha(cwd), base);
  assert.ok(!fs.existsSync(path.join(dir, 'junk.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'fix.js')));

  assert.strictEqual(git.checkout('main', cwd), true);
  assert.strictEqual(git.deleteBranch('phantom/fix-x', cwd), true);
  assert.strictEqual(git.branchExists('phantom/fix-x', cwd), false);
  assert.deepStrictEqual(git.stashPop(stashRef, cwd), { ok: true, conflicted: false, missing: false, stderr: '' });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'dirty\n');
  assert.ok(fs.existsSync(path.join(dir, 'untracked.txt')));
  assert.strictEqual(git.stashExists(stashRef, cwd), false, 'popping removes it from the stack');
});

test('stashPop restores phantom\'s own entry, not whatever landed on top', () => {
  // The stack moves under phantom all the time: the user stashing in another
  // shell, `git pull --autostash`, a second phantom run. A bare `git stash pop`
  // takes the top entry, writes someone else's content over the tree, and
  // reports success -- leaving the real work buried one level down.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const file = path.join(dir, 'a.txt');

  fs.writeFileSync(file, 'MY PRECIOUS WORK\n');
  const mine = git.stashPush('phantom-snapshot', cwd);
  assert.match(mine, /^[0-9a-f]{40}$/);

  // Somebody else pushes a stash while phantom is busy.
  fs.writeFileSync(file, 'UNRELATED SCRATCH\n');
  const theirs = git.stashPush('other-shell', cwd);
  assert.notStrictEqual(theirs, mine);

  const pop = git.stashPop(mine, cwd);
  assert.strictEqual(pop.ok, true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'MY PRECIOUS WORK\n',
    'the user gets their own work back, not the entry that happened to be on top');
  assert.strictEqual(git.stashExists(theirs, cwd), true, "the other shell's stash is left alone");
  assert.strictEqual(git.stashExists(mine, cwd), false);
});

test('a conflicted pop is reported as conflicted, not as a retryable failure', () => {
  // git has already written the merge into the tree and kept the entry on the
  // stack, so "run git stash pop" is advice that cannot work.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const file = path.join(dir, 'a.txt');
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  fs.writeFileSync(file, 'MINE\n');
  const ref = git.stashPush('phantom-snapshot', cwd);
  fs.writeFileSync(file, 'THEIRS\n');
  g('commit', '-qam', 'diverge');

  const pop = git.stashPop(ref, cwd);
  assert.strictEqual(pop.ok, false);
  assert.strictEqual(pop.conflicted, true, 'the caller can tell this apart from a plain failure');
  assert.match(fs.readFileSync(file, 'utf8'), /<<<<<<</, 'the tree really does carry markers now');
  assert.strictEqual(git.stashExists(ref, cwd), true, 'and the entry is still on the stack');
});

test('commitAll works without a configured identity', () => {
  const dir = tmpRepo();
  execFileSync('git', ['config', '--unset', 'user.name'], { cwd: dir });
  execFileSync('git', ['config', '--unset', 'user.email'], { cwd: dir });
  const saved = { ...process.env };
  const emptyCfg = path.join(dir, 'empty-gitconfig');
  fs.writeFileSync(emptyCfg, '');
  process.env.GIT_CONFIG_GLOBAL = emptyCfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
  try {
    fs.writeFileSync(path.join(dir, 'n.txt'), 'n\n');
    const sha = git.commitAll('phantom: identity fallback', { cwd: dir });
    assert.match(sha, /^[0-9a-f]{40}$/);
    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.strictEqual(author, 'phantom <phantom@localhost>');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('ensureExcluded works where .git is a file, not a directory', () => {
  // A linked worktree and a submodule both have a `.git` FILE pointing
  // elsewhere. Joining '.git/info' onto the root and calling mkdirSync throws
  // ENOTDIR there, and ensureExcluded swallows its own errors -- so .phantom/
  // stayed untracked-and-visible, `git status --porcelain` was permanently
  // non-empty, and phantom refused every crash in that tree with "uncommitted
  // changes". Silent, total, and only in the layout no test covered.
  const main = tmpRepo();
  const wt = path.join(path.dirname(main), path.basename(main) + '-wt');
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'feature'], { cwd: main, stdio: 'pipe' });
  try {
    assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'precondition: .git is a file here');

    const errors = [];
    git.ensureExcluded(wt, '.phantom', { onError: (e) => errors.push(e.message) });
    assert.deepStrictEqual(errors, [], 'no error, silent or otherwise');

    // The rule belongs in the shared git dir, which is the main checkout's.
    const exclude = path.join(main, '.git', 'info', 'exclude');
    assert.match(fs.readFileSync(exclude, 'utf8'), /^\.phantom\/$/m);

    // What it is all for: phantom's own directory must not make the tree dirty.
    fs.mkdirSync(path.join(wt, '.phantom'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.phantom', 'crash.json'), '{}');
    assert.strictEqual(git.isDirty({ cwd: wt }), false, 'phantom can still run here');
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: main, stdio: 'pipe' });
  }
});
