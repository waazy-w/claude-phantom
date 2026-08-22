'use strict';

const fs = require('node:fs');
const path = require('node:path');

const git = require('./git');
const ui = require('./ui');
const { timeAgo } = require('./events');
const { loadConfig, ConfigError, DEFAULTS } = require('./config');

const { log, colors } = ui;

/**
 * `phantom ls` and `phantom clean`: the history phantom leaves behind, and a
 * way to prune it.
 *
 * Recovery already prunes `.phantom/crashes/` and `.phantom/reports/` down to
 * `keepReports` on every run, so this module deliberately does NOT re-implement
 * count-based pruning -- it is the manual, branch-aware complement. Nothing at
 * all prunes `phantom/fix-*` branches, and they are what actually gets in the
 * user's way: a month of a crashy dev loop leaves dozens of them in
 * `git branch`, most already merged and therefore pure noise.
 *
 * Everything here is split into three pure-ish layers -- gather state, plan the
 * deletions, apply the plan -- so the destructive step is a small function with
 * nothing to decide, and the deciding is testable without deleting anything.
 */

const SUBCOMMANDS = ['ls', 'clean'];

const BRANCH_PREFIX = 'phantom/fix-';
const BRANCH_REF_GLOB = 'refs/heads/' + BRANCH_PREFIX + '*';

/**
 * Only ever delete a branch whose name phantom could itself have produced:
 * `phantom/fix-<slug>-<suffix>`, where slugify() emits [a-z0-9-] only. Dots and
 * capitals are tolerated for hand-made branches under the same prefix. A second
 * `/`, a `..`, or a leading `-` is refused -- a `-` would be read by git as an
 * option, and the rest is how a name escapes the namespace it is allowed in.
 */
const SAFE_BRANCH_RE = /^phantom\/fix-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Crash JSONs carry the whole output tail (up to ringBufferBytes, 64 MB at the
 * ceiling). Parsing one only buys a nicer `ls` row, so anything oversized is
 * listed from its filename and stat alone rather than read into memory.
 */
const MAX_PARSE_BYTES = 4 * 1024 * 1024;
/** Enough for the post-mortem's `# ` title, which report.js writes first. */
const HEAD_BYTES = 4096;

const DAY_MS = 24 * 60 * 60 * 1000;

class ManageUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManageUsageError';
  }
}

/* -------------------------------------------------------------------------- */
/* reading                                                                     */
/* -------------------------------------------------------------------------- */

/** `.phantom` from a `reportDir` of `.phantom/reports`; mirrors recovery.js. */
function phantomDirOf(reportDir) {
  const norm = String(reportDir).replace(/\\/g, '/').replace(/^\.\//, '');
  return norm.split('/')[0] || '.phantom';
}

/**
 * `20260821-143005-typeerror-boom.json` -> Date.
 *
 * recovery.js builds these names from *local* clock components, so they are
 * parsed back the same way. Returns null for anything that does not match, and
 * the caller falls back to mtime -- a file the user renamed still gets an age.
 */
function timestampFromName(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|\.|$)/.exec(name);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(d.getTime()) ? d : null;
}

function slugFromName(name, suffix) {
  const base = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  const m = /^\d{8}-\d{6}-(.+)$/.exec(base);
  return m ? m[1] : base;
}

/** First `max` bytes of a file, or '' when it cannot be read. */
function readHead(file, max) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

/** @returns {{ command: string|null, errorLine: string|null, exit: number|null, signal: string|null }|null} */
function crashDetail(file, bytes, maxParseBytes) {
  if (bytes > maxParseBytes) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  return {
    // commandLine is the redacted form; `command` + args are the raw ones, so
    // never fall back to them -- a wrapped command routinely carries a token.
    command: typeof data.commandLine === 'string' ? data.commandLine : null,
    errorLine: typeof data.errorLine === 'string' ? data.errorLine : null,
    exit: typeof data.exitCode === 'number' ? data.exitCode : null,
    signal: typeof data.signal === 'string' ? data.signal : null,
  };
}

function reportTitle(file) {
  const m = /^#\s+(.+)$/m.exec(readHead(file, HEAD_BYTES));
  if (!m) return null;
  // "# 👻 Phantom post-mortem — npm run dev (exit 1)": the boilerplate half is
  // the same on every row, so only the summary earns a column.
  return m[1].replace(/^[^A-Za-z0-9]*Phantom post-mortem\s*[—-]\s*/, '').trim() || null;
}

function ageDaysOf(at, now) {
  return Math.max(0, (now - Date.parse(at)) / DAY_MS);
}

function listDir(dir, suffix, kind, root, now, opts) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(suffix));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // raced with a prune, or a broken symlink
    }
    if (!stat.isFile()) continue;
    const when = timestampFromName(name) || new Date(stat.mtimeMs);
    const at = when.toISOString();
    const entry = {
      kind,
      name,
      file,
      rel: path.relative(root, file).replace(/\\/g, '/'),
      bytes: stat.size,
      at,
      ageDays: ageDaysOf(at, now),
      slug: slugFromName(name, suffix),
      detail: null,
    };
    if (opts.details) {
      if (kind === 'crash') {
        entry.detail = crashDetail(file, stat.size, opts.maxParseBytes);
      } else {
        const title = reportTitle(file);
        entry.detail = title === null ? null : { title };
      }
    }
    out.push(entry);
  }
  return out.sort(newestFirst);
}

const newestFirst = (a, b) => Date.parse(b.at) - Date.parse(a.at) || a.name.localeCompare(b.name);

/**
 * `git for-each-ref` over the fix-branch namespace.
 *
 * git.js has no branch-listing helper and this module is not allowed to add
 * one, so it goes through the generic `git.git()` runner -- which already
 * returns null instead of throwing for "not a repo" / "git missing". Fields are
 * tab-separated: a tab cannot occur in a ref name, and the subject comes last,
 * so a (vanishingly rare) tab inside a commit subject is put back by the join.
 *
 * `refname:lstrip=2`, not `refname:short`: shortening is ambiguity-aware, so a
 * *tag* of the same name turns the branch into `heads/phantom/fix-x` -- which
 * matches neither the current branch nor the safe-name rule, so the branch
 * would silently vanish from `ls` and from every plan. lstrip just removes
 * `refs/heads/` and always yields the real branch name.
 */
function forEachRef(extra, opts) {
  const out = git.git([
    'for-each-ref',
    '--format=%(refname:lstrip=2)\t%(objectname)\t%(committerdate:iso-strict)\t%(contents:subject)',
    ...extra,
    BRANCH_REF_GLOB,
  ], opts);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return {
      name: parts[0],
      sha: parts[1] || '',
      at: parts[2] || '',
      subject: parts.slice(3).join('\t'),
    };
  // The ref glob already restricts this to the fix-branch namespace; deletion
  // re-checks the name against SAFE_BRANCH_RE regardless.
  }).filter((b) => b.name);
}

/**
 * Every `phantom/fix-*` branch, newest tip first, each tagged with whether it
 * is already merged into HEAD.
 *
 * "Merged" is deliberately relative to the branch the user is standing on:
 * that is the question `phantom clean --merged` answers, and a branch merged
 * into some other line of development is not safe to delete from here.
 */
function listBranches(root, now) {
  const opts = { cwd: root };
  const merged = new Set(forEachRef(['--merged', 'HEAD'], opts).map((b) => b.name));
  const current = git.currentBranch(opts);
  return forEachRef([], opts).map((b) => {
    const at = Number.isFinite(Date.parse(b.at)) ? new Date(b.at).toISOString() : new Date(0).toISOString();
    return {
      kind: 'branch',
      name: b.name,
      sha: b.sha,
      shortSha: b.sha.slice(0, 8),
      subject: b.subject,
      at,
      ageDays: ageDaysOf(at, now),
      merged: merged.has(b.name),
      current: b.name === current,
    };
  }).sort(newestFirst);
}

/**
 * Everything phantom has left behind in one repo.
 *
 * @param {string} root repo root
 * @param {{ now?: number, reportDir?: string, keepReports?: number, details?: boolean, maxParseBytes?: number }} [opts]
 * @returns {{ root: string, phantomDir: string, crashDir: string, reportDir: string,
 *             currentBranch: string|null, crashes: object[], reports: object[], branches: object[],
 *             keepReports: number, totals: { crashBytes: number, reportBytes: number } }}
 */
function listPhantomState(root, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const reportDirRel = opts.reportDir || DEFAULTS.reportDir;
  const reportDir = path.resolve(root, reportDirRel);
  const crashDir = path.resolve(reportDir, '..', 'crashes');
  const readOpts = {
    details: opts.details !== false,
    maxParseBytes: opts.maxParseBytes === undefined ? MAX_PARSE_BYTES : opts.maxParseBytes,
  };
  const crashes = listDir(crashDir, '.json', 'crash', root, now, readOpts);
  const reports = listDir(reportDir, '.md', 'report', root, now, readOpts);
  return {
    root,
    phantomDir: path.resolve(root, phantomDirOf(reportDirRel)),
    crashDir,
    reportDir,
    currentBranch: git.currentBranch({ cwd: root }),
    crashes,
    reports,
    branches: listBranches(root, now),
    keepReports: opts.keepReports === undefined ? DEFAULTS.keepReports : opts.keepReports,
    totals: {
      crashBytes: crashes.reduce((n, c) => n + c.bytes, 0),
      reportBytes: reports.reduce((n, r) => n + r.bytes, 0),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* planning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Decide what a `clean` would remove. Pure: touches nothing on disk.
 *
 * The defaults are the conservative ones. Branches are only ever selected when
 * they are merged into HEAD, unless `unmerged` is explicitly set -- an unmerged
 * `phantom/fix-*` branch is the only copy of work Claude did, and `git branch
 * -D` on it is unrecoverable outside the reflog. Crash captures and
 * post-mortems are only selected with an explicit age (or `all`), because
 * `keepReports` already bounds them by count and a second, silent, count-based
 * rule would be a surprise.
 *
 * @param {object} state from listPhantomState
 * @param {{ unmerged?: boolean, olderThanDays?: number|null, all?: boolean,
 *           branches?: boolean, files?: boolean }} [opts]
 * @returns {{ deletions: object[], kept: object[], reasons: string[],
 *             counts: { branches: number, crashes: number, reports: number, bytes: number },
 *             unmergedSelected: number }}
 */
function planClean(state, opts = {}) {
  const olderThan = opts.olderThanDays === undefined || opts.olderThanDays === null ? null : Number(opts.olderThanDays);
  const wantBranches = opts.branches !== false;
  const wantFiles = opts.files !== false;
  const deletions = [];
  const kept = [];
  const reasons = [];

  const tooYoung = (entry) => olderThan !== null && entry.ageDays < olderThan;

  reasons.push(opts.unmerged
    ? 'branches: every phantom/fix-* branch, merged or not (--unmerged)'
    : 'branches: only those already merged into ' + (state.currentBranch || 'HEAD'));
  if (olderThan !== null) reasons.push('only items at least ' + olderThan + ' day(s) old (--older-than ' + olderThan + ')');
  reasons.push(opts.all || olderThan !== null
    ? 'files: crash captures and post-mortems under ' + path.basename(state.phantomDir) + '/'
    : 'files: none — crash captures and post-mortems need --older-than or --all (keepReports=' + state.keepReports + ' already prunes them by count)');

  for (const b of state.branches) {
    if (!wantBranches) { kept.push({ ...b, reason: 'branches not selected (--files)' }); continue; }
    if (b.current) { kept.push({ ...b, reason: 'you are on this branch' }); continue; }
    // The name rule is checked before any of the user's filters: it is not a
    // preference, it is the boundary of what this command is allowed to touch.
    if (!SAFE_BRANCH_RE.test(b.name)) { kept.push({ ...b, reason: 'name is outside the phantom/fix-<slug> shape phantom creates' }); continue; }
    if (!b.merged && !opts.unmerged) { kept.push({ ...b, reason: 'not merged into ' + (state.currentBranch || 'HEAD') + ' (needs --unmerged)' }); continue; }
    if (tooYoung(b)) { kept.push({ ...b, reason: 'newer than ' + olderThan + ' day(s)' }); continue; }
    deletions.push({ ...b, reason: b.merged ? 'merged into ' + (state.currentBranch || 'HEAD') : 'unmerged, deleted on request (--unmerged)' });
  }

  const files = [...state.crashes, ...state.reports];
  for (const f of files) {
    if (!wantFiles) { kept.push({ ...f, reason: 'files not selected (--branches)' }); continue; }
    // Same order as branches: the boundary first, the user's filters after.
    if (!insidePhantomDir(f.file, state)) { kept.push({ ...f, reason: 'outside ' + path.basename(state.phantomDir) + '/' }); continue; }
    if (olderThan === null && !opts.all) { kept.push({ ...f, reason: 'no age given; keepReports=' + state.keepReports + ' prunes these by count' }); continue; }
    if (tooYoung(f)) { kept.push({ ...f, reason: 'newer than ' + olderThan + ' day(s)' }); continue; }
    deletions.push({ ...f, reason: olderThan === null ? 'selected by --all' : 'older than ' + olderThan + ' day(s)' });
  }

  const counts = {
    branches: deletions.filter((d) => d.kind === 'branch').length,
    crashes: deletions.filter((d) => d.kind === 'crash').length,
    reports: deletions.filter((d) => d.kind === 'report').length,
    bytes: deletions.reduce((n, d) => n + (d.bytes || 0), 0),
  };
  return {
    root: state.root,
    deletions: deletions.sort(newestFirst),
    kept,
    reasons,
    counts,
    unmergedSelected: deletions.filter((d) => d.kind === 'branch' && !d.merged).length,
  };
}

/**
 * Is `file` really inside this repo's `.phantom/`?
 *
 * The plan is data, and data can be wrong -- a stale state, a hand-built plan,
 * a symlink in the reports directory. This is the check that makes "never touch
 * anything outside .phantom/" true at the moment of deletion rather than only
 * at the moment of selection.
 */
/**
 * realpath, falling back to the lexical path when the target does not exist
 * (a file being planned for deletion may already be gone).
 */
function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * Is `file` one of the directories phantom itself owns?
 *
 * The boundary is the reports and crashes directories, not a single "phantom
 * dir" -- with `reportDir: "reports"` the captures live at `<root>/crashes`,
 * which is a SIBLING of the reports directory rather than inside it, so a
 * first-path-segment check rejected every crash capture and `clean` reported
 * success while deleting none of them. Only the two-segment default happened
 * to work.
 */
function insidePhantomDir(file, state) {
  const dirs = [state.crashDir, state.reportDir, state.phantomDir].filter(Boolean);
  if (!dirs.length) return false;
  // Two conditions, and the second is what makes it safe. Being inside
  // `reportDir` is not enough when reportDir may itself be a symlink pointing
  // out of the tree -- realpath then agrees the file is "inside" it, because it
  // is, just not inside the repository. Anchoring on the repo root as well is
  // what keeps a redirected directory from carrying deletions out of the tree.
  if (!containedIn(file, state.root)) return false;
  return dirs.some((d) => containedIn(file, d));
}

function containedIn(file, dir) {
  if (!dir) return false;
  // Resolve symlinks on BOTH sides before comparing. The check used to be
  // purely lexical, and unlink() follows symlinks -- so a repo shipping
  // `.phantom/reports -> ../outside` produced entries whose lexical path was
  // `.phantom/reports/x.md` (passing here) while the unlink resolved through
  // the link and deleted the real file outside the repo. Lexical containment
  // is not containment when the filesystem can redirect you.
  const realDir = realpathOr(dir);
  const realFile = realpathOr(path.resolve(file));
  const relReal = path.relative(realDir, realFile);
  if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) return false;
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* -------------------------------------------------------------------------- */
/* applying                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Delete a merged branch with `git branch -d`.
 *
 * git.js only offers the force form, and this module may not add to it. The
 * safe form is worth doing locally: it re-checks merged-ness inside git at the
 * moment of deletion, so a plan that went stale (the user checked out something
 * else, or pushed a commit onto the branch, between `ls` and `clean`) fails
 * loudly instead of quietly destroying work.
 */
const deleteMergedBranch = (name, opts) => git.git(['branch', '-d', name], opts) !== null;

/**
 * Carry out a plan. Every entry is re-validated here, because this is the last
 * place before something is actually destroyed.
 *
 * @param {object} plan from planClean
 * @param {{ cwd?: string, state?: object }} [opts]
 * @returns {{ deleted: object[], failed: object[], counts: object }}
 */
function applyClean(plan, opts = {}) {
  const root = opts.cwd || plan.root;
  const gitOpts = { cwd: root };
  // The re-check needs the same boundary the plan was built with. A minimal
  // fallback that named only `phantomDir` made the root anchor undefined, so
  // every file was refused -- a safe failure, but a silent one that reported
  // success with nothing deleted. Rebuild the whole shape.
  const state = opts.state || (() => {
    const reportDir = path.resolve(root, '.phantom', 'reports');
    return {
      root: path.resolve(root),
      phantomDir: path.resolve(root, '.phantom'),
      reportDir,
      crashDir: path.resolve(reportDir, '..', 'crashes'),
    };
  })();
  const current = git.currentBranch(gitOpts);
  const deleted = [];
  const failed = [];

  for (const entry of plan.deletions) {
    if (entry.kind === 'branch') {
      if (!SAFE_BRANCH_RE.test(entry.name)) { failed.push({ ...entry, error: 'refused: not a phantom/fix-* branch name' }); continue; }
      if (entry.name === current) { failed.push({ ...entry, error: 'refused: it is the current branch' }); continue; }
      // Force only where the plan says the user opted into it; everything else
      // goes through -d so git gets the final word on "is this merged".
      const ok = entry.merged ? deleteMergedBranch(entry.name, gitOpts) : git.deleteBranch(entry.name, gitOpts);
      if (ok) deleted.push(entry); else failed.push({ ...entry, error: 'git refused to delete the branch' });
      continue;
    }
    if (!insidePhantomDir(entry.file, state)) { failed.push({ ...entry, error: 'refused: outside ' + state.phantomDir }); continue; }
    try {
      fs.unlinkSync(entry.file);
      deleted.push(entry);
    } catch (err) {
      // Already gone is a success: the goal was for it not to be there.
      if (err && err.code === 'ENOENT') deleted.push(entry);
      else failed.push({ ...entry, error: err && err.message ? err.message : String(err) });
    }
  }

  return {
    deleted,
    failed,
    counts: {
      branches: deleted.filter((d) => d.kind === 'branch').length,
      crashes: deleted.filter((d) => d.kind === 'crash').length,
      reports: deleted.filter((d) => d.kind === 'report').length,
      bytes: deleted.reduce((n, d) => n + (d.bytes || 0), 0),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Local wall-clock, matching the filenames these entries came from. */
function formatWhen(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '?';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const truncate = (s, max) => (String(s).length <= max ? String(s) : String(s).slice(0, max - 1) + '…');

/**
 * Pad columns to a common width. Widths are measured on the plain text and the
 * colour is applied to the already-padded cell, so escape sequences never
 * count towards a column -- the same trap ui.visibleLength exists for.
 */
function table(rows, paints = [], indent = '  ') {
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] || 0, String(cell).length); });
  return rows.map((row) => indent + row.map((cell, i) => {
    const padded = i === row.length - 1 ? String(cell) : String(cell).padEnd(widths[i]);
    return typeof paints[i] === 'function' ? paints[i](padded, row) : padded;
  }).join('  ').replace(/\s+$/, ''));
}

function section(title, count, extra) {
  return colors.bold(title) + ' ' + colors.dim('(' + count + (extra ? ' · ' + extra : '') + ')');
}

function limited(items, limit) {
  if (limit === null || items.length <= limit) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/**
 * The `phantom ls` view: newest first, one line each, columns that line up.
 * @param {object} state
 * @param {{ limit?: number|null, now?: number }} [opts]
 * @returns {string}
 */
function renderState(state, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const limit = opts.limit === undefined ? 10 : opts.limit;
  const out = [];
  const where = state.currentBranch ? ' (on ' + state.currentBranch + ')' : ' (detached HEAD)';
  out.push(colors.bold('👻 phantom history') + ' ' + colors.dim(state.root + where));
  out.push('');

  out.push(section('fix branches', state.branches.length));
  if (!state.branches.length) {
    out.push(colors.dim('  none'));
  } else {
    const { shown, hidden } = limited(state.branches, limit);
    out.push(...table(shown.map((b) => [
      b.name,
      timeAgo(b.at, now),
      b.current ? 'current' : b.merged ? 'merged' : 'unmerged',
      truncate(b.subject || '(no commits of its own)', 60),
    ]), [
      (cell, row) => (row[2] === 'unmerged' ? colors.yellow(cell) : cell),
      colors.dim,
      (cell, row) => (row[2] === 'unmerged' ? colors.yellow(cell) : row[2] === 'current' ? colors.cyan(cell) : colors.green(cell)),
      colors.dim,
    ]));
    if (hidden) out.push(colors.dim('  … ' + hidden + ' more'));
  }
  out.push('');

  out.push(section('crash captures', state.crashes.length, formatBytes(state.totals.crashBytes)));
  if (!state.crashes.length) {
    out.push(colors.dim('  none'));
  } else {
    const { shown, hidden } = limited(state.crashes, limit);
    out.push(...table(shown.map((c) => [
      formatWhen(c.at),
      timeAgo(c.at, now),
      formatBytes(c.bytes),
      truncate(describeCrash(c), 64),
    ]), [null, colors.dim, colors.dim, colors.dim]));
    if (hidden) out.push(colors.dim('  … ' + hidden + ' more'));
  }
  out.push('');

  out.push(section('post-mortems', state.reports.length, formatBytes(state.totals.reportBytes)));
  if (!state.reports.length) {
    out.push(colors.dim('  none'));
  } else {
    const { shown, hidden } = limited(state.reports, limit);
    out.push(...table(shown.map((r) => [
      formatWhen(r.at),
      timeAgo(r.at, now),
      formatBytes(r.bytes),
      truncate((r.detail && r.detail.title) || r.slug, 64),
    ]), [null, colors.dim, colors.dim, colors.dim]));
    if (hidden) out.push(colors.dim('  … ' + hidden + ' more'));
  }
  out.push('');

  const merged = state.branches.filter((b) => b.merged && !b.current).length;
  out.push(colors.dim(state.keepReports > 0
    ? 'keepReports=' + state.keepReports + ' prunes crash captures and post-mortems automatically; branches are never pruned.'
    : 'keepReports=0: nothing is pruned automatically.'));
  if (merged) out.push(colors.dim('phantom clean --merged would delete ' + merged + ' merged fix branch(es).'));
  return out.join('\n') + '\n';
}

function describeCrash(c) {
  if (!c.detail) return c.slug;
  const parts = [];
  if (c.detail.command) parts.push(c.detail.command);
  if (c.detail.errorLine) parts.push(c.detail.errorLine);
  return parts.length ? parts.join(' — ') : c.slug;
}

/**
 * What a clean would do, item by item. Printed before the confirmation, so it
 * has to be complete: no "… 12 more" on the list of things about to be deleted.
 * @returns {string}
 */
function renderPlan(plan, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const out = [];
  for (const reason of plan.reasons) out.push(colors.dim('· ' + reason));
  out.push('');
  if (!plan.deletions.length) {
    out.push(colors.dim('nothing to delete.'));
    return out.join('\n') + '\n';
  }
  out.push(colors.bold('would delete:'));
  out.push(...table(plan.deletions.map((d) => [
    d.kind === 'branch' ? 'branch' : d.kind,
    d.kind === 'branch' ? d.name : d.rel,
    timeAgo(d.at, now),
    d.kind === 'branch' ? (d.merged ? 'merged' : colors.yellow('UNMERGED')) : formatBytes(d.bytes),
  ]), [colors.dim, null, colors.dim, colors.dim]));
  out.push('');
  const c = plan.counts;
  out.push(colors.bold(c.branches + ' branch(es), ' + c.crashes + ' crash capture(s), ' + c.reports + ' post-mortem(s)')
    + colors.dim(c.bytes ? ' · ' + formatBytes(c.bytes) + ' on disk' : ''));
  if (plan.unmergedSelected) {
    out.push(colors.yellow('⚠ ' + plan.unmergedSelected + ' of these branches are NOT merged: their commits will only be reachable via the reflog.'));
  }
  return out.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* argument parsing                                                            */
/* -------------------------------------------------------------------------- */

function parseNumber(flag, raw) {
  if (!/^\d+(\.\d+)?$/.test(String(raw))) throw new ManageUsageError(flag + ' expects a non-negative number, got "' + raw + '"');
  return Number(raw);
}

/**
 * Flags for `ls` and `clean`. Deliberately separate from cli.js's parser: the
 * two share spellings (`--dry-run`) with different meanings, and cli.js's
 * parser stops at the first non-flag because everything after it belongs to the
 * wrapped command -- which is exactly wrong here.
 * @returns {object}
 */
function parseManageArgs(name, argv) {
  const flags = {
    help: false, all: false, limit: undefined, dryRun: false, yes: false,
    merged: false, unmerged: false, olderThanDays: null, branches: undefined, files: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    let key = tok;
    let inline;
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq !== -1) { key = tok.slice(0, eq); inline = tok.slice(eq + 1); }
    const value = () => {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) throw new ManageUsageError(key + ' requires a value');
      return v;
    };
    switch (key) {
      case '--help': case '-h': flags.help = true; break;
      case '--all': flags.all = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--yes': case '-y': flags.yes = true; break;
      case '--merged': flags.merged = true; break;
      case '--unmerged': flags.unmerged = true; break;
      case '--older-than': flags.olderThanDays = parseNumber(key, value()); break;
      case '--limit': flags.limit = parseNumber(key, value()); break;
      case '--branches': flags.branches = true; flags.files = false; break;
      case '--files': flags.files = true; flags.branches = false; break;
      default:
        throw new ManageUsageError('unknown option ' + tok + ' (see phantom ' + name + ' --help)');
    }
  }
  if (flags.merged && flags.unmerged) throw new ManageUsageError('--merged and --unmerged contradict each other');
  return flags;
}

function lsHelp() {
  return [
    'Usage: phantom ls [--all] [--limit <n>]',
    '',
    "Lists this repo's phantom history, newest first: phantom/fix-* branches (with",
    'whether each is merged into the branch you are on), crash captures and post-mortems.',
    '',
    '  --all         show every entry instead of the newest 10 per section',
    '  --limit <n>   show n entries per section',
    '',
    'To wrap the real `ls` command instead, use: phantom -- ls',
  ].join('\n');
}

function cleanHelp() {
  return [
    'Usage: phantom clean [--merged|--unmerged] [--older-than <days>] [--all]',
    '                     [--branches|--files] [--dry-run] [--yes]',
    '',
    'Prunes phantom/fix-* branches and, with an age filter, the crash captures and',
    'post-mortems under .phantom/. Nothing outside those is ever touched.',
    '',
    '  --merged            only branches already merged into HEAD (the default)',
    '  --unmerged          also delete UNMERGED fix branches (their commits survive',
    '                      only in the reflog — opt in deliberately)',
    '  --older-than <days> only entries at least <days> old; also the switch that',
    '                      selects crash captures and post-mortems at all',
    '  --all               select crash captures and post-mortems regardless of age',
    '  --branches          branches only          --files   crash captures and reports only',
    '  --dry-run           print the plan and stop',
    '  --yes               skip the confirmation prompt',
    '',
    'Crash captures and post-mortems are already pruned to the newest `keepReports`',
    '(default 50) on every phantom run; this is the manual, branch-aware complement.',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* commands                                                                    */
/* -------------------------------------------------------------------------- */

const isSubcommand = (name) => SUBCOMMANDS.includes(name);

/** Config is advisory here: a broken .phantomrc must not stop the user tidying up. */
function configFor(cwd) {
  try {
    return loadConfig(cwd);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log.warn('config error, using defaults: ' + err.message);
    return { ...DEFAULTS };
  }
}

function repoRoot(cwd) {
  const root = git.root({ cwd });
  if (!root) log.error('not a git repository: ' + cwd);
  return root;
}

/**
 * @param {string[]} argv arguments after the subcommand
 * @param {{ cwd?: string, out?: NodeJS.WritableStream, now?: number }} [io]
 * @returns {Promise<number>} exit code
 */
async function runList(argv = [], io = {}) {
  const out = io.out || process.stderr;
  const cwd = io.cwd || process.cwd();
  let flags;
  try {
    flags = parseManageArgs('ls', argv);
  } catch (err) {
    if (!(err instanceof ManageUsageError)) throw err;
    log.error(err.message);
    return 2;
  }
  if (flags.help) { out.write(lsHelp() + '\n'); return 0; }
  const root = repoRoot(cwd);
  if (!root) return 2;
  const config = configFor(cwd);
  const state = listPhantomState(root, { now: io.now, reportDir: config.reportDir, keepReports: config.keepReports });
  const limit = flags.all ? null : (flags.limit === undefined ? 10 : flags.limit);
  out.write(renderState(state, { limit, now: io.now }));
  return 0;
}

/**
 * @param {string[]} argv arguments after the subcommand
 * @param {{ cwd?: string, out?: NodeJS.WritableStream, now?: number, ask?: Function }} [io]
 * @returns {Promise<number>} exit code
 */
async function runClean(argv = [], io = {}) {
  const out = io.out || process.stderr;
  const cwd = io.cwd || process.cwd();
  const ask = io.ask || ui.ask;
  let flags;
  try {
    flags = parseManageArgs('clean', argv);
  } catch (err) {
    if (!(err instanceof ManageUsageError)) throw err;
    log.error(err.message);
    return 2;
  }
  if (flags.help) { out.write(cleanHelp() + '\n'); return 0; }
  const root = repoRoot(cwd);
  if (!root) return 2;
  const config = configFor(cwd);
  const state = listPhantomState(root, {
    now: io.now,
    reportDir: config.reportDir,
    keepReports: config.keepReports,
    // Nothing in the plan or its rendering reads a crash JSON's contents, and
    // reading every one of them to delete some of them would be the slowest
    // part of the command by far.
    details: false,
  });
  const plan = planClean(state, {
    unmerged: flags.unmerged,
    olderThanDays: flags.olderThanDays,
    all: flags.all,
    branches: flags.branches,
    files: flags.files,
  });
  out.write(renderPlan(plan, { now: io.now }));
  if (!plan.deletions.length) return 0;
  if (flags.dryRun) {
    log.info('dry run: nothing was deleted');
    return 0;
  }
  if (!flags.yes) {
    const answer = await ask('delete these ' + plan.deletions.length + ' item(s)? this cannot be undone [y/N]', { keys: ['y', 'n'] });
    if (answer !== 'y') {
      // null means "could not ask" -- a pipe, CI, a timeout. Saying so beats
      // both silently deleting and silently doing nothing.
      log.info(answer === null ? 'nothing deleted (no answer available; pass --yes to skip the prompt)' : 'nothing deleted');
      return 1;
    }
  }
  const results = applyClean(plan, { cwd: root, state });
  for (const d of results.deleted) {
    if (d.kind === 'branch') log.info('deleted branch ' + d.name + colors.dim(' (restore with: git branch ' + d.name + ' ' + d.shortSha + ')'));
  }
  for (const f of results.failed) log.error('could not delete ' + (f.name || f.rel) + ': ' + f.error);
  const c = results.counts;
  log.info('deleted ' + c.branches + ' branch(es), ' + c.crashes + ' crash capture(s), ' + c.reports + ' post-mortem(s)'
    + (c.bytes ? colors.dim(' · ' + formatBytes(c.bytes) + ' freed') : ''));
  return results.failed.length ? 1 : 0;
}

/**
 * @param {string} name 'ls' or 'clean'
 * @returns {Promise<number>} exit code
 */
function runSubcommand(name, argv = [], io = {}) {
  if (name === 'ls') return runList(argv, io);
  if (name === 'clean') return runClean(argv, io);
  return Promise.resolve(2);
}

module.exports = {
  SUBCOMMANDS, isSubcommand, runSubcommand, runList, runClean,
  listPhantomState, planClean, applyClean,
  renderState, renderPlan, parseManageArgs, lsHelp, cleanHelp,
  ManageUsageError, formatBytes, SAFE_BRANCH_RE,
};
