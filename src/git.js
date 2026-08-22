'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { execFileSync } = require('node:child_process');

/**
 * Thin git wrappers. Every function takes `{ cwd }`, never throws for
 * "not a repo" / "git missing", and returns null or false instead.
 */

function run(args, { cwd } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: true, stdout: stdout.replace(/\n$/, ''), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message),
    };
  }
}

/** @returns {string|null} stdout of `git <args>` or null on failure */
function git(args, opts) {
  const r = run(args, opts);
  return r.ok ? r.stdout : null;
}

const isRepo = (opts) => git(['rev-parse', '--is-inside-work-tree'], opts) === 'true';

/**
 * Repo root as a *native* path. git always prints `/` separators, on Windows
 * too, but every consumer feeds this straight into `path.relative`, `path.join`
 * or a `startsWith` against a `process.cwd()`-derived path -- which on win32
 * carry `\`. Mixing the two forms makes the same directory compare unequal:
 * `context.js` dedupes `{ cwd, root }` into a Set and `crash.js` picks the
 * first matching prefix, so a `C:/...` root silently loses to the `C:\...` cwd
 * and stack-trace paths come out relative to the wrong directory. Normalising
 * once, here at the boundary, keeps that whole class of bug out of the callers.
 * @returns {string|null}
 */
const root = (opts) => {
  const out = git(['rev-parse', '--show-toplevel'], opts);
  return out ? path.resolve(out) : null;
};
const headSha = (opts) => git(['rev-parse', '--verify', '--quiet', 'HEAD'], opts) || null;
/** @returns {string|null} branch name, or null when detached / unborn / not a repo */
const currentBranch = (opts) => git(['symbolic-ref', '--short', '-q', 'HEAD'], opts) || null;
const status = (opts) => git(['status', '--porcelain'], opts);
const isDirty = (opts) => Boolean(status(opts));

/** @returns {string[]} `git log --oneline -n <n>` lines, newest first */
const recentCommits = (n, opts) => {
  const out = git(['log', '--oneline', '-n', String(n || 10)], opts);
  return out ? out.split('\n').filter(Boolean) : [];
};

/** Creates `name` from HEAD and switches to it (`git checkout -b`). */
const createBranch = (name, opts) => run(['checkout', '-b', name], opts).ok;
const checkout = (name, opts) => run(['checkout', name], opts).ok;

/**
 * Stash the working tree (including untracked files) and return the stash
 * *commit sha*, not a boolean.
 *
 * The sha is the whole point. `git stash pop` with no argument pops the top of
 * the stack, which is only phantom's entry if nothing else pushed one in the
 * meantime -- and plenty does: the user in another shell, a `git pull
 * --autostash`, a second phantom run in the same repo. When that happens the
 * unqualified pop writes someone else's content over the user's tree and
 * reports success, leaving the real work buried at stash@{1}.
 *
 * @returns {string|null} stash commit sha, or null when nothing was stashed
 */
const stashPush = (message, opts) => {
  const r = run(['stash', 'push', '-u', '-m', message], opts);
  if (!r.ok || /No local changes to save/.test(r.stdout)) return null;
  return git(['rev-parse', '--verify', '--quiet', 'stash@{0}'], opts) || null;
};

/**
 * @returns {number} current position of stash commit `ref`, or -1 if it is gone.
 * Positions shift as entries are pushed and popped, which is exactly why the
 * sha is what gets stored and the index is looked up fresh at pop time.
 */
const stashIndexOf = (ref, opts) => {
  if (!ref) return -1;
  const list = git(['stash', 'list', '--format=%H'], opts);
  return list ? list.split('\n').indexOf(ref) : -1;
};

/** @returns {boolean} true when `ref` is still on the stash stack */
const stashExists = (ref, opts) => stashIndexOf(ref, opts) !== -1;

/**
 * Pop a specific stash commit, identified by the sha stashPush returned.
 *
 * `git stash pop` only accepts a `stash@{n}` reference, and n moves as entries
 * are pushed and popped -- so the sha is resolved to a current index here,
 * immediately before the pop. That is what makes this safe against a stack that
 * changed underneath us: without it, a bare pop takes whatever is on top, which
 * may belong to the user's other shell or a second phantom run.
 *
 * A conflicted pop is NOT a retryable failure: git has already written the
 * merge into the working tree and kept the entry on the stack, so telling the
 * user to "run git stash pop" (as phantom used to) hands them a command that
 * cannot succeed. `conflicted` lets the caller say what actually happened.
 *
 * @returns {{ ok: boolean, conflicted: boolean, missing: boolean, stderr: string }}
 */
const stashPop = (ref, opts) => {
  // Tolerate the old (opts) call shape rather than feeding an object to git.
  if (ref && typeof ref === 'object') { opts = ref; ref = null; }
  let target = 'stash@{0}';
  if (ref) {
    const i = stashIndexOf(ref, opts);
    if (i === -1) return { ok: false, conflicted: false, missing: true, stderr: 'stash entry ' + ref.slice(0, 10) + ' is no longer on the stack' };
    target = 'stash@{' + i + '}';
  }
  const r = run(['stash', 'pop', target], opts);
  const conflicted = !r.ok && /conflict/i.test(r.stderr + r.stdout);
  return { ok: r.ok, conflicted, missing: false, stderr: r.stderr };
};
const resetHard = (sha, opts) => run(['reset', '--hard', sha], opts).ok;
/** `git clean -fd` (never -x: ignored files such as .env are left alone). */
const cleanUntracked = (opts) => run(['clean', '-fd'], opts).ok;

/** @returns {string[]} files changed since `sha` plus untracked files, sorted unique */
const changedFilesSince = (sha, opts) => {
  const diff = git(['diff', '--name-only', sha], opts);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], opts);
  const all = new Set([...(diff || '').split('\n'), ...(untracked || '').split('\n')].filter(Boolean));
  return [...all].sort();
};

/**
 * Is `file` in the index? Decides whether a change to it can be undone by the
 * hard reset, or whether it is genuinely beyond phantom's reach -- the
 * difference between a scary warning being true and being a false alarm.
 */
const isTracked = (file, opts) => Boolean(git(['ls-files', '--', file], opts));

const branchExists = (name, opts) => run(['rev-parse', '--verify', '--quiet', 'refs/heads/' + name], opts).ok;
const deleteBranch = (name, opts) => run(['branch', '-D', name], opts).ok;

/**
 * Fast-forward or commit a merge of `name` into the current branch.
 * `--no-edit` keeps git from opening an editor on a merge commit; a conflict
 * leaves the repo mid-merge, which the caller reports rather than unwinding --
 * silently running `git merge --abort` would throw away a resolvable merge.
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
const mergeBranch = (name, opts) => run(['merge', '--no-edit', name], opts);

/**
 * `git add -A && git commit -m <message>`. Supplies an identity and disables
 * signing/hooks when needed so it works on a fresh machine.
 * @returns {string|null} new HEAD sha, or null when nothing was committed
 */
const commitAll = (message, opts) => {
  if (!run(['add', '-A'], opts).ok) return null;
  const cfg = ['-c', 'commit.gpgsign=false'];
  if (!git(['config', 'user.name'], opts)) cfg.push('-c', 'user.name=phantom');
  if (!git(['config', 'user.email'], opts)) cfg.push('-c', 'user.email=phantom@localhost');
  const r = run([...cfg, 'commit', '--no-verify', '-m', message], opts);
  return r.ok ? headSha(opts) : null;
};

/**
 * Keep `<dir>/` out of commits and audits via .git/info/exclude (never edits the
 * user's .gitignore). Best-effort; pass opts.onError to hear about failures.
 */
function ensureExcluded(root, dir, opts = {}) {
  const entry = dir.replace(/\/+$/, '') + '/';
  // `.git` is only a directory in a plain clone. In a linked worktree and in a
  // submodule it is a *file* pointing elsewhere, so joining '.git/info' onto
  // the root and calling mkdirSync throws ENOTDIR -- which this function then
  // swallows, leaving .phantom/ unexcluded. From there `git status --porcelain`
  // is permanently non-empty and phantom refuses every crash it is asked to
  // recover from. --git-common-dir resolves all three layouts (and points at
  // the parent's .git for a worktree, which is where exclude belongs).
  const common = git(['rev-parse', '--git-common-dir'], { cwd: root });
  const gitDir = common ? path.resolve(root, common) : path.join(root, '.git');
  const infoDir = path.join(gitDir, 'info');
  const file = path.join(infoDir, 'exclude');
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing.split('\n').some((l) => l.trim() === entry || l.trim() === entry.slice(0, -1) || l.trim() === '/' + entry)) return;
    fs.mkdirSync(infoDir, { recursive: true });
    fs.appendFileSync(file, (existing && !existing.endsWith('\n') ? '\n' : '') + '# added by claude-phantom\n' + entry + '\n');
  } catch (err) {
    if (typeof opts.onError === 'function') opts.onError(err);
  }
}

module.exports = {
  git, isRepo, root, headSha, currentBranch, status, isDirty, recentCommits,
  createBranch, checkout, stashPush, stashPop, stashExists, stashIndexOf, resetHard, cleanUntracked,
  changedFilesSince, branchExists, isTracked, deleteBranch, mergeBranch, commitAll, ensureExcluded };

