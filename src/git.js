'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { execFileSync } = require('node:child_process');

/**
 * Thin git wrappers. Every function takes `{ cwd }`, never throws for
 * "not a repo" / "git missing", and returns null or false instead.
 */

function run(args, { cwd, timeoutMs } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Only the callers that can face an unbounded repo pass a timeout; a
      // plain `rev-parse` that is somehow slow is still better than one that is
      // killed. `undefined` is execFileSync's "wait forever", the old default.
      timeout: timeoutMs || undefined,
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

/**
 * Restore specific tracked paths from HEAD, leaving everything else alone.
 *
 * `reset --hard` is the wrong tool in a dry run: no branch was created, so it
 * would land on the user's own checkout and take their uncommitted work with
 * it. Naming the paths keeps the blast radius to the files the session touched.
 * @returns {boolean}
 */
const restorePaths = (files, opts) => {
  if (!files || !files.length) return true;
  return run(['checkout', 'HEAD', '--', ...files], opts).ok;
};
/** `git clean -fd` (never -x: ignored files such as .env are left alone). */
const cleanUntracked = (opts) => run(['clean', '-fd'], opts).ok;

/** @returns {string[]} untracked, non-ignored files */
const untrackedFiles = (opts) => {
  const out = git(['ls-files', '--others', '--exclude-standard'], opts);
  return out ? out.split('\n').filter(Boolean) : [];
};

/**
 * Stash the named paths (untracked ones included) and return the stash sha.
 *
 * Used to rescue untracked files before `git clean -fd` removes them. `clean`
 * is unrecoverable -- content that was never added has no reflog entry -- so
 * anything the user created while phantom was running was simply gone after a
 * Ctrl+C. A stash is recoverable and costs one entry.
 * @returns {string|null}
 */
const stashPaths = (message, files, opts) => {
  if (!files || !files.length) return null;
  const r = run(['stash', 'push', '-u', '-m', message, '--', ...files], opts);
  if (!r.ok || /No local changes to save/.test(r.stdout)) return null;
  return git(['rev-parse', '--verify', '--quiet', 'stash@{0}'], opts) || null;
};

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
 * Diff options that must be on EVERY diff phantom runs.
 *
 * `--no-ext-diff` and `--no-textconv`: `diff.external` and a `textconv` filter
 * are arbitrary programs out of the user's config. Phantom shells out with
 * stdin closed and prints the result to a terminal, so an interactive external
 * differ waits forever on input that never comes, and a textconv that renders a
 * PDF returns megabytes. Neither is anything phantom asked for.
 *
 * `color.ui=never` AND `color.diff=never`: git suppresses colour on its own
 * when stdout is a pipe -- unless the user set `always`, and then raw SGR
 * escapes land in a string phantom re-prints and stores in a report. Both keys
 * are needed: `color.diff` is the more specific setting and wins over
 * `color.ui`, so overriding `ui` alone leaves the escapes in place.
 */
const DIFF_BASE = ['--no-pager', '-c', 'color.ui=never', '-c', 'color.diff=never', 'diff', '--no-ext-diff', '--no-textconv'];

/**
 * A diff of `from..to` rendered for a terminal, already bounded.
 *
 * Phantom prints to stderr with no pager, so an unbounded diff is not a
 * feature: 5000 changed lines scroll the crash report, the branch name and
 * every command the banner just printed out of the scrollback, which is the
 * exact information the user is about to need. So the result is always
 * `--stat` (the part that is worth reading in full) plus at most `maxLines` of
 * patch, and a last line saying what was cut and how to see the rest.
 *
 * Three bounds, because they fail differently:
 *   - maxLines (200)      -- a big refactor.
 *   - maxLineLength (500) -- ONE line can be the flood. A minified bundle or a
 *                            generated lockfile diffs as a single 300KB line,
 *                            which is ~4000 wrapped rows on an 80-col terminal.
 *   - maxBytes (32KB)     -- the total, whatever mix of the two got it there.
 *                            What reaches the user is wrapped rows, not lines:
 *                            200 legal 400-character lines is 80KB and a
 *                            thousand rows on an 80-column terminal. 32KB is
 *                            ~400 rows, which a normal 200-line patch (well
 *                            under 160 chars a line) never comes close to.
 * Above `patchBudget` (4000) changed lines the patch is not even requested:
 * `run` buffers the whole child output in memory, and a repo-wide diff can be
 * hundreds of megabytes. --numstat costs one extra diff and stays tiny.
 *
 * Binary files need no bound: without `--binary`/`--text` git prints one
 * "Binary files ... differ" line and the stat shows the byte delta. Never add
 * those flags to make the patch "complete".
 *
 * @returns {string|null} the text, '' when the two refs are identical, or null
 *   when the refs cannot be diffed at all (bad ref, not a repo).
 */
function diffText(from, to, opts = {}) {
  if (!from || !to) return null;
  const maxLines = opts.maxLines || 200;
  const maxBytes = opts.maxBytes || 32 * 1024;
  const maxFiles = opts.maxFiles || 40;
  const maxLineLength = opts.maxLineLength || 500;
  const patchBudget = opts.patchBudget || 4000;
  const o = { cwd: opts.cwd, timeoutMs: opts.timeoutMs || 15000 };

  // Three dots, not two. `a..b` renders everything `a` gained since the branch
  // point as a deletion, so the moment the user pulls, phantom's one-line fix
  // is shown as a patch that also reverts their colleagues' work -- and the
  // whole point of this function is that someone is about to decide from it.
  // `a...b` is what the branch itself changed. Unrelated histories have no
  // merge base and git exits 128, so fall back rather than show nothing.
  let range = from + '...' + to;
  let numstat = run([...DIFF_BASE, '--numstat', range], o);
  if (!numstat.ok) {
    range = from + '..' + to;
    numstat = run([...DIFF_BASE, '--numstat', range], o);
    if (!numstat.ok) return null;
  }
  if (!numstat.stdout) return '';

  // "-\t-\tfile" is git's numstat for a binary file; counting the dashes as 0
  // is right -- they contribute no patch lines.
  let changed = 0;
  for (const line of numstat.stdout.split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (m) changed += Number(m[1]) + Number(m[2]);
  }

  const stat = run([...DIFF_BASE, '--stat', '--stat-count=' + maxFiles, range], o);
  const out = [stat.ok ? stat.stdout : '(diffstat unavailable)'];

  if (changed > patchBudget) {
    out.push('', '   ' + changed + ' changed lines -- patch omitted. See: git diff ' + range);
    return out.join('\n');
  }

  const patch = run([...DIFF_BASE, '--patch', range], o);
  if (!patch.ok) return out.join('\n');

  const lines = patch.stdout ? patch.stdout.split('\n') : [];
  const kept = [];
  // The budget is for the whole returned string: the stat block and the
  // "... n of m" line land on the terminal too, so they are charged against it
  // rather than added on top of a patch that already exactly filled it.
  let bytes = Buffer.byteLength(out.join('\n')) + 256;
  let clipped = lines.length > maxLines;
  for (const raw of lines.slice(0, maxLines)) {
    const line = raw.length > maxLineLength
      ? raw.slice(0, maxLineLength) + ' [+' + (raw.length - maxLineLength) + ' chars]'
      : raw;
    // Bytes, not characters: a diff of a file full of CJK or emoji is three or
    // four times its length, and the terminal gets the bytes.
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maxBytes) { clipped = true; break; }
    kept.push(line);
    bytes += size;
  }
  if (kept.length) out.push('', kept.join('\n'));
  if (clipped) out.push('', '   ... ' + kept.length + ' of ' + lines.length + ' patch lines shown. Full diff: git diff ' + range);
  return out.join('\n');
}

/** @returns {string[]} paths git left unmerged (conflict markers in the tree) */
const unmergedPaths = (opts) => {
  const out = git(['diff', '--name-only', '--diff-filter=U'], opts);
  return out ? out.split('\n').filter(Boolean) : [];
};

/**
 * Is a cherry-pick still in progress, and therefore what gets the user out?
 *
 * Both checks are needed and neither alone is enough. `-n` never writes
 * CHERRY_PICK_HEAD (it is the ref a commit would be made from, and -n makes no
 * commit), but a *range* pick does write .git/sequencer -- and that state
 * survives `git reset --hard`, so a tree that looks clean keeps reporting
 * "Cherry-pick currently in progress" until someone runs --abort.
 */
const cherryPickInProgress = (opts) => {
  if (git(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], opts)) return true;
  const rel = git(['rev-parse', '--git-path', 'sequencer/todo'], opts);
  if (!rel) return false;
  try { return fs.existsSync(path.resolve((opts && opts.cwd) || process.cwd(), rel)); } catch { return false; }
};

/**
 * Apply everything on `branch` to the working tree, staged and uncommitted.
 *
 * This is the answer to "I want the fix, not phantom's commit": `-n` leaves the
 * change in the index for the user to commit under their own name and message,
 * where `merge` lands phantom's commit object and its wording on their branch
 * forever.
 *
 * The range form is not a detail. `git cherry-pick -n <branch>` picks only the
 * branch TIP, and phantom commits again on every verify-retry -- so a fix that
 * took two passes would apply half of itself, cleanly, with no warning. Worse,
 * the tip alone usually conflicts against a parent state that is not there.
 * `HEAD..<branch>` applies exactly the commits the user does not already have.
 * It also makes git use the sequencer, which is what makes `git cherry-pick
 * --abort` a real escape hatch: after a plain `-n` pick it exits with "no
 * cherry-pick or revert in progress" and the user is stuck holding markers.
 *
 * Refusing to start on a dirty tree is the load-bearing precondition. `-n`
 * stages its result, so the user's own uncommitted work would end up in the
 * same index with no way left to tell the two apart -- not by phantom, and not
 * by the user reading `git diff --cached`. It is also what makes the reported
 * `files` list exactly "what phantom applied", and what makes abandoning a
 * conflicted pick safe: there is nothing else in the tree to lose.
 *
 * Like stashPop, a conflict is NOT a retryable failure -- git has written the
 * merge into the tree -- and it is not unwound here either: the user may want
 * to resolve it, and that is their call to make.
 *
 * @returns {{ ok: boolean, conflicted: boolean, dirty: boolean, missing: boolean,
 *   empty: boolean, files: string[], conflicts: string[], abortCommand: string|null,
 *   stderr: string }}
 *   `files` are the paths now staged (on a conflict, the ones that did apply);
 *   `conflicts` the ones carrying markers; `abortCommand` the command that
 *   actually undoes what happened, or null when nothing was left behind.
 */
function cherryPickNoCommit(branch, opts = {}) {
  const base = { ok: false, conflicted: false, dirty: false, missing: false, empty: false, files: [], conflicts: [], abortCommand: null, stderr: '' };
  if (!branch) return { ...base, stderr: 'no branch given' };
  // Resolve once, to a full sha, and use that for the pick: a branch and a file
  // can share a name, and the sha cannot be re-read as anything else.
  const target = git(['rev-parse', '--verify', '--quiet', branch + '^{commit}'], opts);
  if (!target) return { ...base, missing: true, stderr: branch + ' is not a branch or commit in this repo' };
  if (!headSha(opts)) return { ...base, stderr: 'no commit is checked out' };

  const st = status(opts);
  if (st) return { ...base, dirty: true, stderr: 'the working tree has uncommitted changes; commit or stash them first' };

  const count = Number(git(['rev-list', '--count', 'HEAD..' + target], opts));
  if (!Number.isFinite(count)) return { ...base, stderr: 'could not count the commits to apply' };
  // An empty range is not a no-op to git: `cherry-pick` exits 128 with "empty
  // commit set passed". Say what is actually true instead.
  if (count === 0) return { ...base, empty: true, stderr: 'nothing to apply: HEAD already contains every commit on ' + branch };

  const r = run(['cherry-pick', '-n', 'HEAD..' + target], opts);
  const staged = () => {
    const out = git(['diff', '--cached', '--name-only'], opts);
    return out ? out.split('\n').filter(Boolean) : [];
  };
  if (r.ok) return { ...base, ok: true, files: staged() };

  const conflicts = unmergedPaths(opts);
  const unmerged = new Set(conflicts);
  // Only offer an escape when git really did leave something behind; telling a
  // user to abort a pick that never started is its own small betrayal.
  const abortCommand = cherryPickInProgress(opts) ? 'git cherry-pick --abort'
    : (conflicts.length ? 'git reset --hard HEAD' : null);
  const stderr = String(r.stderr || '').trim().split('\n').filter(Boolean)[0] || 'cherry-pick failed';
  // `git diff --cached` lists unmerged paths too; keep `files` meaning "applied".
  return { ...base, conflicted: conflicts.length > 0, files: staged().filter((f) => !unmerged.has(f)), conflicts, abortCommand, stderr };
}

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
  createBranch, checkout, stashPush, stashPop, stashExists, stashIndexOf, resetHard, restorePaths, cleanUntracked, untrackedFiles, stashPaths,
  changedFilesSince, branchExists, isTracked, deleteBranch, mergeBranch, commitAll, ensureExcluded,
  diffText, cherryPickNoCommit };

