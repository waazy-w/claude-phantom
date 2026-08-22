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

/** A repo whose `fix` branch carries `n` commits, with main checked out. */
function repoWithFixBranch(dir, n) {
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('checkout', '-q', '-b', 'fix');
  for (let i = 1; i <= n; i++) {
    fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), 'fix ' + i + '\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'phantom: fix step ' + i);
  }
  g('checkout', '-q', 'main');
}

test('cherryPickNoCommit applies the whole branch, staged and uncommitted', () => {
  // `git cherry-pick -n <branch>` picks only the TIP. Phantom commits again on
  // every verify-retry, so a two-pass fix would apply half of itself -- cleanly,
  // and with nothing in the output to suggest anything was missing.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  repoWithFixBranch(dir, 3);
  const before = git.headSha(cwd);

  const res = git.cherryPickNoCommit('fix', cwd);
  assert.strictEqual(res.ok, true, res.stderr);
  assert.deepStrictEqual(res.files.sort(), ['f1.txt', 'f2.txt', 'f3.txt'], 'every commit on the branch, not just the tip');
  assert.deepStrictEqual(res.conflicts, []);
  assert.strictEqual(res.abortCommand, null, 'nothing was left behind to abort');

  for (const f of ['f1.txt', 'f2.txt', 'f3.txt']) assert.strictEqual(fs.readFileSync(path.join(dir, f), 'utf8'), 'fix ' + f[1] + '\n');
  assert.strictEqual(git.headSha(cwd), before, 'no commit was made: the user writes their own');
  assert.strictEqual(git.currentBranch(cwd), 'main');
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepStrictEqual(staged, ['f1.txt', 'f2.txt', 'f3.txt'], 'and it is staged, ready to commit');
  const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.strictEqual(subject, 'init', "phantom's commit message did not land on the user's branch");
});

test('a conflicted cherry-pick is reported, and abortCommand is a command that works', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const file = path.join(dir, 'a.txt');
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });

  g('checkout', '-q', '-b', 'fix');
  fs.writeFileSync(file, 'THE FIX\n');
  g('commit', '-qam', 'phantom: fix');
  g('checkout', '-q', 'main');
  fs.writeFileSync(file, 'MY OWN EDIT\n');
  g('commit', '-qam', 'mine');

  const res = git.cherryPickNoCommit('fix', cwd);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.conflicted, true, 'the caller can tell this apart from a plain failure');
  assert.deepStrictEqual(res.conflicts, ['a.txt']);
  assert.deepStrictEqual(res.files, [], 'a conflicted path is not also reported as applied');
  assert.match(fs.readFileSync(file, 'utf8'), /<<<<<<</, 'the tree really does carry markers now');
  assert.ok(res.stderr, 'and there is something to print');

  // The whole reason abortCommand is computed rather than hardcoded: after a
  // plain `cherry-pick -n <branch>` git writes no CHERRY_PICK_HEAD and --abort
  // fails with "no cherry-pick or revert in progress"; after the range form it
  // writes .git/sequencer, which `git reset --hard` does NOT clear -- the tree
  // goes clean and git still says "Cherry-pick currently in progress".
  assert.strictEqual(res.abortCommand, 'git cherry-pick --abort');
  assert.ok(fs.existsSync(path.join(dir, '.git', 'sequencer', 'todo')), 'precondition: reset --hard alone would not be enough');

  execFileSync('git', res.abortCommand.split(' ').slice(1), { cwd: dir, stdio: 'pipe' });
  assert.strictEqual(git.isDirty(cwd), false, 'the user is all the way out');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'MY OWN EDIT\n', 'with their own work intact');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'sequencer')), 'and no lingering in-progress state');
});

test('cherryPickNoCommit refuses a dirty tree instead of mixing it in', () => {
  // -n stages what it applies. Started on a dirty tree, the user's uncommitted
  // work and phantom's fix end up in one index with nothing left to tell them
  // apart -- and abandoning the pick would take the user's work with it.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  repoWithFixBranch(dir, 1);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'WORK IN PROGRESS\n');

  const res = git.cherryPickNoCommit('fix', cwd);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.dirty, true);
  assert.strictEqual(res.conflicted, false);
  assert.strictEqual(res.abortCommand, null, 'nothing started, so nothing to abort');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'WORK IN PROGRESS\n');
  assert.ok(!fs.existsSync(path.join(dir, 'f1.txt')), 'nothing was applied');
  assert.strictEqual(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }), '', 'and nothing was staged');
});

test('cherryPickNoCommit reports a missing branch, an empty range, and a non-repo', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };

  const missing = git.cherryPickNoCommit('phantom/fix-nope', cwd);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.missing, true);
  assert.strictEqual(missing.conflicted, false);

  // Already applied: `git cherry-pick` exits 128 with "empty commit set passed",
  // which is not something to show a user who did nothing wrong.
  repoWithFixBranch(dir, 1);
  execFileSync('git', ['merge', '--no-edit', '-q', 'fix'], { cwd: dir, stdio: 'pipe' });
  const empty = git.cherryPickNoCommit('fix', cwd);
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.empty, true);
  assert.strictEqual(empty.missing, false);
  assert.match(empty.stderr, /already contains/);

  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-norepo-'));
  const outside = git.cherryPickNoCommit('fix', { cwd: nowhere });
  assert.strictEqual(outside.ok, false, 'no throw, just a result');
  assert.deepStrictEqual(outside.files, []);
});

test('diffText returns a stat plus a bounded patch', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  execFileSync('git', ['checkout', '-q', '-b', 'fix'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  execFileSync('git', ['commit', '-qam', 'small change'], { cwd: dir, stdio: 'pipe' });

  const out = git.diffText('main', 'fix', cwd);
  assert.match(out, /a\.txt \| 2 \+\+/, 'the stat is there');
  assert.match(out, /1 file changed/);
  assert.match(out, /^\+two$/m, 'and so is the patch');
  assert.doesNotMatch(out, /patch lines shown|patch omitted/, 'a small diff is not truncated');
});

test('diffText is empty when nothing differs and null when it cannot diff', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  execFileSync('git', ['branch', 'same'], { cwd: dir, stdio: 'pipe' });
  assert.strictEqual(git.diffText('main', 'same', cwd), '', 'identical refs: empty, not null and not a stray header');
  assert.strictEqual(git.diffText('main', 'nope', cwd), null, 'a ref that does not resolve');
  assert.strictEqual(git.diffText('main', null, cwd), null);
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-norepo-'));
  assert.strictEqual(git.diffText('main', 'fix', { cwd: nowhere }), null, 'and no throw outside a repo');
});

test('diffText never floods the terminal: line count, line width and total bytes', () => {
  // Phantom prints to stderr with no pager. An unbounded diff scrolls the crash
  // report, the branch name and every command the banner just printed out of
  // the scrollback -- exactly what the user needs next.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('checkout', '-q', '-b', 'fix');
  const big = Array.from({ length: 900 }, (_, i) => 'line ' + i).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'big.txt'), big);
  // One line IS the flood: a minified bundle or a lockfile diffs as a single
  // 300KB line, which is thousands of wrapped rows on an 80-column terminal.
  fs.writeFileSync(path.join(dir, 'app.min.js'), 'var x=' + 'a'.repeat(300000) + ';\n');
  g('add', '-A');
  g('commit', '-qm', 'a lot');

  const out = git.diffText('main', 'fix', cwd);
  const lines = out.split('\n');
  assert.ok(lines.length <= 210, 'line count is bounded, got ' + lines.length);
  assert.ok(Buffer.byteLength(out) <= 32 * 1024, 'byte count is bounded, got ' + Buffer.byteLength(out));
  assert.ok(lines.every((l) => l.length <= 600), 'no single line is a flood, widest was ' + Math.max(...lines.map((l) => l.length)));
  assert.match(out, /\[\+\d+ chars\]/, 'the clipped line says how much was cut');
  assert.match(out, /\.\.\. \d+ of \d+ patch lines shown\. Full diff: git diff main\.\.\.fix/,
    'and the user is told how to see the rest');

  // Past the budget the patch is not even requested: `run` buffers the whole
  // child output, and a repo-wide diff can be hundreds of megabytes.
  const huge = Array.from({ length: 5000 }, (_, i) => 'x' + i).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'huge.txt'), huge);
  g('add', '-A');
  g('commit', '-qm', 'much more');
  const omitted = git.diffText('main', 'fix', cwd);
  assert.match(omitted, /changed lines -- patch omitted\. See: git diff main\.\.\.fix/);
  assert.match(omitted, /files changed/, 'the stat still comes through');
  assert.ok(Buffer.byteLength(omitted) < 8 * 1024, 'and it stays tiny, got ' + Buffer.byteLength(omitted));
});

test('diffText does not dump binary content', () => {
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  execFileSync('git', ['checkout', '-q', '-b', 'fix'], { cwd: dir, stdio: 'pipe' });
  const blob = Buffer.alloc(200000);
  for (let i = 0; i < blob.length; i++) blob[i] = i % 251;
  fs.writeFileSync(path.join(dir, 'blob.bin'), blob);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'binary'], { cwd: dir, stdio: 'pipe' });

  const out = git.diffText('main', 'fix', cwd);
  assert.match(out, /blob\.bin \|\s+Bin 0 -> 200000 bytes/, 'the stat reports the size');
  assert.match(out, /Binary files .* differ/, 'and the patch says so in one line');
  assert.ok(Buffer.byteLength(out) < 2048, '200KB of bytes stayed out, got ' + Buffer.byteLength(out));
  assert.doesNotMatch(out, /\u0000/, 'no NULs reached the terminal');
});

test('diffText shows what the branch changed, not what the base moved past', () => {
  // Two dots renders every commit the base gained since the branch point as a
  // deletion: the moment the user pulls, phantom's one-line fix reads as a
  // patch that also reverts their colleagues' work.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('checkout', '-q', '-b', 'fix');
  fs.writeFileSync(path.join(dir, 'fix.txt'), 'the fix\n');
  g('add', '-A');
  g('commit', '-qm', 'phantom: fix');
  g('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'colleague.txt'), 'important work\n');
  g('add', '-A');
  g('commit', '-qm', 'meanwhile, on main');

  const out = git.diffText('main', 'fix', cwd);
  assert.match(out, /fix\.txt/, "the branch's own change is shown");
  assert.doesNotMatch(out, /colleague\.txt/, "and main's newer work is not shown as a deletion");
});

test('diffText strips colour even when the user forced it on', () => {
  // git suppresses colour on a pipe by itself -- unless color.diff=always, and
  // then raw SGR escapes land in a string phantom re-prints and stores.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  execFileSync('git', ['config', 'color.diff', 'always'], { cwd: dir });
  execFileSync('git', ['config', 'color.ui', 'always'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'fix'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'coloured\n');
  execFileSync('git', ['commit', '-qam', 'colour'], { cwd: dir, stdio: 'pipe' });

  const out = git.diffText('main', 'fix', cwd);
  assert.doesNotMatch(out, /\u001b\[/, 'no escape sequences in the returned text');
  assert.match(out, /^\+coloured$/m);
});

test('diffText ignores a configured external differ', { skip: process.platform === 'win32' ? 'needs a POSIX shell' : false }, () => {
  // diff.external and textconv filters are arbitrary programs out of the user's
  // config. Phantom shells out with stdin closed, so an interactive differ
  // waits forever on input that never arrives, and a textconv that renders a
  // PDF returns megabytes -- neither is anything phantom asked for.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const differ = path.join(dir, 'differ.sh');
  fs.writeFileSync(differ, '#!/bin/sh\necho "EXTERNAL DIFFER RAN"\n');
  fs.chmodSync(differ, 0o755);
  execFileSync('git', ['config', 'diff.external', differ], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'fix'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'patched\n');
  execFileSync('git', ['commit', '-qam', 'change'], { cwd: dir, stdio: 'pipe' });

  const out = git.diffText('main', 'fix', cwd);
  assert.doesNotMatch(out, /EXTERNAL DIFFER RAN/);
  assert.match(out, /^\+patched$/m, 'a real patch, produced by git itself');
});

test('diffText stops on total bytes even when every line is legal on its own', () => {
  // Lines just under the width limit pass the width check and the line count
  // check individually, and still add up to megabytes: prose, long import
  // lists, base64 blobs pasted into a fixture. The byte cap is the one that
  // catches that, so it has to bite before the line cap here.
  const dir = tmpRepo();
  const cwd = { cwd: dir };
  const wide = Array.from({ length: 250 }, (_, i) => ('w' + i).padEnd(490, '.')).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'wide.txt'), wide);
  execFileSync('git', ['checkout', '-q', '-b', 'fix'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'wide'], { cwd: dir, stdio: 'pipe' });

  const out = git.diffText('main', 'fix', cwd);
  assert.ok(Buffer.byteLength(out) <= 32 * 1024, 'byte count is bounded, got ' + Buffer.byteLength(out));
  assert.doesNotMatch(out, /\[\+\d+ chars\]/, 'no line was wide enough to be clipped on its own');
  const shown = /\.\.\. (\d+) of (\d+) patch lines shown/.exec(out);
  assert.ok(shown, 'it says what was cut');
  assert.ok(Number(shown[1]) < 150, 'and the bytes ran out well before the 200-line budget did, at ' + shown[1]);
  assert.ok(Number(shown[1]) > 0 && Number(shown[2]) > 250, 'but something useful was still shown');
});
