'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../src/git');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
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

  assert.strictEqual(git.stashPush('nothing', cwd), false);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u\n');
  assert.strictEqual(git.stashPush('phantom-snapshot', cwd), true);
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
  assert.strictEqual(git.stashPop(cwd), true);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'dirty\n');
  assert.ok(fs.existsSync(path.join(dir, 'untracked.txt')));
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
