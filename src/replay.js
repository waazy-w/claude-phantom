'use strict';

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const ui = require('./ui');
const { timeAgo } = require('./events');
const { commandLineOf } = require('./context');
const { summarizeExit } = require('./crash');

const { log, colors } = ui;

/** @typedef {import('./context').CrashContext} CrashContext */
/** @typedef {import('./config').Config} Config */

/**
 * Replay a crash phantom already captured.
 *
 * Recovery gets refused for reasons that have nothing to do with the crash --
 * a dirty working tree, no `claude` on PATH, a repository with no commits --
 * and the only way to try again was to make the application crash again. It
 * never had to be: step 2 of every recovery writes the whole CrashContext to
 * `.phantom/crashes/`, so the crash is already on disk. This module reads one
 * back, checks it still describes THIS repository, and hands it to runRecovery
 * unchanged. The Claude Code plugin has shipped `/phantom:recover` for exactly
 * this since the beginning; the CLI had no equivalent.
 *
 * Nothing here re-runs the crashed command to re-capture it. Reusing what was
 * captured is the entire point -- re-capturing needs the crash to happen again,
 * which is the problem being solved.
 */

const DEFAULT_REPORT_DIR = '.phantom/reports';
/** Older than this and the capture describes a repository that has moved on. */
const MAX_AGE_DAYS = 30;
const AGE_WARN_MS = 24 * 60 * 60 * 1000;
/**
 * `slug` is joined into a filename by runRecovery (`<ts>-<slug>.json`, `.md`),
 * so a hand-edited or hostile capture carrying `../../../etc/passwd` would
 * write outside the repository phantom is allowed to touch.
 */
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Statuses whose outcome runRecovery's own banner already states in full (see cli.js). */
const BANNERED = new Set(['fixed', 'unfixed', 'dry-run', 'timeout', 'aborted']);

/**
 * Where recovery.js puts crash captures: the `crashes` sibling of reportDir.
 * @param {string} root repository root
 * @param {string} [reportDir]
 * @returns {string}
 */
function crashDirOf(root, reportDir) {
  return path.resolve(root, reportDir || DEFAULT_REPORT_DIR, '..', 'crashes');
}

const rel = (root, p) => path.relative(root, p).replace(/\\/g, '/') || p;

const clip = (s, n) => {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, n - 1) + '…' : text;
};

/**
 * Same directory on disk?
 *
 * Both sides go through realpath so a symlinked checkout (`/tmp` -> `/private/tmp`
 * on macOS, a worktree reached through a symlinked home) does not read as a
 * different repository. Windows is the only case folded: git and the shell
 * disagree about the drive letter's case there, and comparing them literally
 * would refuse every replay on that platform.
 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let out = path.resolve(String(p));
    try { out = fs.realpathSync.native(out); } catch { /* gone: compare what was recorded */ }
    return out.replace(/[\\/]+$/, '');
  };
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const commitExists = (sha, root) =>
  Boolean(sha) && git.git(['rev-parse', '--verify', '--quiet', sha + '^{commit}'], { cwd: root }) !== null;

/**
 * @param {unknown} ctx
 * @returns {string|null} why this is not a crash context, or null when it is
 */
function schemaProblem(ctx) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return 'not a JSON object';
  const bad = [];
  // Exactly the fields runRecovery reads without checking. `args` in
  // particular is spread into a spawn, so a string there would become one
  // argument per character.
  if (typeof ctx.command !== 'string' || !ctx.command.trim()) bad.push('command');
  if (ctx.args !== undefined && !Array.isArray(ctx.args)) bad.push('args (not an array)');
  if (typeof ctx.slug !== 'string' || !SLUG_RE.test(ctx.slug)) bad.push('slug');
  // Absolute, specifically. A relative root like "." resolves against the cwd,
  // so it matched the wrong-repo check from any repository the user happened to
  // be standing in -- which is exactly the check that is supposed to stop a
  // capture from one checkout being replayed into another.
  if (!ctx.git || typeof ctx.git !== 'object' || typeof ctx.git.root !== 'string' || !ctx.git.root
      || !path.isAbsolute(ctx.git.root)) bad.push('git.root (must be an absolute path)');
  // Executed downstream if present, so it must at least be the right type.
  if (ctx.testCommand !== undefined && ctx.testCommand !== null && typeof ctx.testCommand !== 'string') bad.push('testCommand');
  // Guarded on isArray: a non-array `args` is already reported above, and
  // calling .some() on it here would throw out of the validator instead of
  // rejecting the file -- which would take `phantom ls` down with it.
  if (Array.isArray(ctx.args) && ctx.args.some((a) => typeof a !== 'string')) bad.push('args (not all strings)');
  if (typeof ctx.capturedAt !== 'string' || !Number.isFinite(Date.parse(ctx.capturedAt))) bad.push('capturedAt');
  return bad.length ? 'not a phantom crash context (missing or invalid: ' + bad.join(', ') + ')' : null;
}

/**
 * @typedef {object} CrashEntry
 * @property {string} path absolute path to the capture
 * @property {string} name basename, `<timestamp>-<slug>.json`
 * @property {boolean} ok false when the file is not a readable crash context
 * @property {string|null} problem why not, when `ok` is false
 * @property {string|null} capturedAt ISO timestamp recorded in the capture
 * @property {number} mtimeMs fallback ordering for a capture with no timestamp
 * @property {number|null} ageMs
 * @property {string|null} commandLine redacted command line that crashed
 * @property {string|null} errorLine
 * @property {string|null} exitSummary
 * @property {string|null} root repository the capture was taken in
 * @property {string|null} baseSha HEAD at capture time
 * @property {string|null} branch branch at capture time
 */

/** @returns {CrashEntry} */
function readEntry(file, now) {
  const entry = {
    path: file, name: path.basename(file), ok: false, problem: null,
    capturedAt: null, mtimeMs: 0, ageMs: null,
    commandLine: null, errorLine: null, exitSummary: null, root: null, baseSha: null, branch: null,
  };
  try { entry.mtimeMs = fs.statSync(file).mtimeMs; } catch { /* raced with a prune */ }
  let ctx;
  try {
    ctx = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    entry.problem = 'unreadable: ' + clip(err.message, 80);
    return entry;
  }
  entry.problem = schemaProblem(ctx);
  if (entry.problem) return entry;
  entry.ok = true;
  entry.capturedAt = ctx.capturedAt;
  entry.ageMs = Math.max(0, now - Date.parse(ctx.capturedAt));
  entry.commandLine = commandLineOf(ctx);
  entry.errorLine = ctx.errorLine || null;
  entry.exitSummary = summarizeExit(ctx);
  entry.root = ctx.git.root;
  entry.baseSha = ctx.git.headSha || null;
  entry.branch = ctx.git.branch || null;
  return entry;
}

// A capture with no usable timestamp still has to sort somewhere; mtime is the
// only other evidence of when it arrived.
const sortKeyOf = (e) => (e.capturedAt ? Date.parse(e.capturedAt) : e.mtimeMs);

/**
 * Every capture in the repo's crash directory, newest first.
 *
 * Unreadable files are listed too, with `ok: false` and the reason: they are
 * exactly what the user needs to see when `phantom recover` refuses to pick
 * one, and hiding them makes an empty-looking list out of a full directory.
 *
 * @param {string} root repository root
 * @param {{ reportDir?: string, now?: number }} [opts]
 * @returns {CrashEntry[]}
 */
function listCrashes(root, opts = {}) {
  const dir = crashDirOf(root, opts.reportDir);
  const now = opts.now || Date.now();
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const entries = names.map((name) => readEntry(path.join(dir, name), now));
  // Ties are broken by name descending: filenames start with the timestamp, so
  // two captures from the same second still come out newest first.
  entries.sort((a, b) => sortKeyOf(b) - sortKeyOf(a) || (a.name < b.name ? 1 : -1));
  return entries;
}

const refuse = (reason, message, extra) => ({ ok: false, reason, message, hint: null, path: null, ...extra });

/**
 * Load a saved context and prove it still belongs here.
 *
 * @param {string|null} pathOrNull a capture to replay, or null for the newest
 * @param {string} root repository root the replay is being asked for
 * @param {{ reportDir?: string, cwd?: string, force?: boolean, maxAgeDays?: number, now?: number }} [opts]
 *   `cwd` resolves a relative `pathOrNull` (the user may be in a subdirectory);
 *   `force` downgrades the two refusals a human can legitimately overrule.
 * @returns {{ ok: true, ctx: CrashContext, warnings: string[], entry: CrashEntry }
 *          | { ok: false, reason: string, message: string, hint: string|null, path: string|null }}
 */
function loadCrash(pathOrNull, root, opts = {}) {
  const now = opts.now || Date.now();
  const dir = crashDirOf(root, opts.reportDir);
  let file;
  if (pathOrNull) {
    file = path.resolve(opts.cwd || root, String(pathOrNull));
    if (!fs.existsSync(file)) {
      return refuse('not-found', 'no such crash capture: ' + pathOrNull, { path: file, hint: 'list what is available with: phantom recover --list' });
    }
  } else {
    const entries = listCrashes(root, { reportDir: opts.reportDir, now });
    if (!entries.length) {
      return refuse('no-crashes', 'no saved crashes in ' + rel(root, dir)
        + '; phantom writes one every time it takes over a crash');
    }
    // The newest, whatever state it is in. Silently skipping past a corrupt
    // newest capture to an older one would replay a crash the user did not ask
    // for, and they would have no way to tell from the output.
    file = entries[0].path;
  }

  const entry = readEntry(file, now);
  if (!entry.ok) {
    return refuse('invalid', rel(root, file) + ' is ' + entry.problem, { path: file, hint: 'pick another with: phantom recover --list' });
  }
  const ctx = JSON.parse(fs.readFileSync(file, 'utf8'));

  // runRecovery works in ctx.git.root, not in the directory phantom was invoked
  // from. A capture that names another checkout therefore does not fail loudly:
  // it quietly stashes, branches, patches and commits over there, in a project
  // the user is not even looking at. This is the one refusal with no --force --
  // if the capture belongs to another repository, that repository is where it
  // has to be replayed.
  if (!samePath(ctx.git.root, root)) {
    const gone = !fs.existsSync(ctx.git.root);
    return refuse('wrong-repo',
      rel(root, file) + ' was captured in ' + ctx.git.root + (gone ? ' (which no longer exists)' : '') + ', not in ' + root,
      { path: file, hint: gone ? 'that repository is gone; there is nothing safe to replay this against'
        : 'replay it there: cd ' + ctx.git.root + ' && phantom recover' });
  }
  if (!git.isRepo({ cwd: root })) {
    return refuse('not-a-repo', root + ' is not a git repository; phantom only recovers inside git repos', { path: file });
  }

  const warnings = [];
  const soften = (reason, message, hint) => {
    if (!opts.force) return refuse(reason, message, { path: file, hint: hint + ', or replay it anyway with --force' });
    warnings.push(message + ' (replaying anyway: --force)');
    return null;
  };

  // A base commit that is not in this repository means the capture predates a
  // history rewrite -- or, more worryingly, was taken in a clone that merely
  // sits at the same path. Either way the diff phantom is about to reason
  // about is not the code that crashed.
  if (entry.baseSha && !commitExists(entry.baseSha, root)) {
    const bad = soften('missing-base',
      'the commit it was captured against (' + entry.baseSha.slice(0, 10) + ') is not in this repository',
      'check you are on the right branch');
    if (bad) return bad;
  }
  const maxAgeMs = (Number(opts.maxAgeDays) > 0 ? Number(opts.maxAgeDays) : MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  if (entry.ageMs > maxAgeMs) {
    const bad = soften('stale',
      rel(root, file) + ' was captured ' + timeAgo(entry.capturedAt, now) + ', which is almost certainly not the code you have now',
      'reproduce the crash for a fresh capture');
    if (bad) return bad;
  }

  const head = git.headSha({ cwd: root });
  if (entry.baseSha && head && head !== entry.baseSha) {
    warnings.push('the repository has moved on since the capture (HEAD is ' + head.slice(0, 10)
      + ', the crash was captured at ' + entry.baseSha.slice(0, 10) + '); the bug may already be fixed');
  }
  const branch = git.currentBranch({ cwd: root });
  if (entry.branch && branch && entry.branch !== branch) {
    // runRecovery returns the user to ctx.git.branch when it finishes, not to
    // wherever they started, so this one is worth saying out loud.
    warnings.push('captured on ' + entry.branch + ' but you are on ' + branch
      + '; recovery will put you back on ' + entry.branch + ' when it finishes');
  }
  if (entry.ageMs > AGE_WARN_MS) warnings.push('this capture is from ' + timeAgo(entry.capturedAt, now));
  if (!ctx.errorLine && !ctx.stackTrace && !(ctx.hintFiles || []).length && !ctx.testCommand) {
    warnings.push('the capture has no error line, no stack trace, no file hints and no test command — there is very little to go on');
  }

  // ---- Everything below treats the capture as untrusted input. ----
  //
  // A crash context used to be a file phantom WROTE. `phantom recover` makes it
  // a file phantom READS, and a repository can ship one: clone a repo, hit a
  // crash, run `phantom recover`, and whatever the planted capture names gets
  // run. Two fields are executed downstream --
  //
  //   ctx.testCommand -> resolveTestCommand() returns it verbatim when config
  //                      sets none, and runTests() runs it with `shell: true`
  //   ctx.command/args -> reproduce() re-spawns them
  //
  // -- so validating the schema is not enough; the values themselves are the
  // payload. `testCommand` is dropped outright: phantom can always resolve it
  // locally from config or package.json, so there is no reason to take a shell
  // string from a file. The command is not droppable (replaying it is the whole
  // point), so it is surfaced for confirmation instead.
  //
  // Dropped silently, not warned about: every capture phantom writes records a
  // test command, so warning would fire on every ordinary replay, and recovery
  // prints the command it actually resolved ("running tests independently: X")
  // a moment later anyway. A warning that fires every time teaches people to
  // ignore warnings.
  const sanitized = { ...ctx };
  delete sanitized.testCommand;

  return { ok: true, ctx: sanitized, warnings, entry, willRun: commandLineOf(sanitized) };
}

function printList(entries, root, dir, now) {
  if (!entries.length) {
    log.warn('no saved crashes in ' + rel(root, dir) + '; phantom writes one every time it takes over a crash');
    return;
  }
  log.info(entries.length + ' saved crash' + (entries.length === 1 ? '' : 'es') + ' in ' + rel(root, dir) + ', newest first:');
  const width = String(entries.length).length;
  entries.forEach((e, i) => {
    const n = colors.dim(String(i + 1).padStart(width) + '.');
    if (!e.ok) {
      log.warn('  ' + n + ' ' + e.name + '  ' + colors.yellow('(' + e.problem + ')'));
      return;
    }
    log.info('  ' + n + ' ' + colors.bold(e.name) + '  ' + colors.dim(timeAgo(e.capturedAt, now)));
    log.info('     ' + colors.dim(clip(e.commandLine, 60) + ' — ' + e.exitSummary));
    if (e.errorLine) log.info('     ' + colors.red(clip(e.errorLine, 90)));
  });
  log.info(colors.dim('replay the newest with `phantom recover`, or a specific one with `phantom recover <file>`'));
}

function announceReplay(entry, root, now) {
  ui.banner([
    // The basename, not the path: the whole point of a banner is that it fits
    // on one line, and `.phantom/crashes/` is the same for every capture.
    colors.bold('👻 replaying ' + entry.name),
    clip(entry.commandLine, 90) + ' — ' + entry.exitSummary + colors.dim(' · captured ' + timeAgo(entry.capturedAt, now)),
    ...(entry.errorLine ? [colors.red(clip(entry.errorLine, 90))] : []),
  ], { color: colors.cyan });
}

/**
 * Reject anything left over after the subcommand's own flags were parsed.
 * @returns {{ file: string|null, error: string|null }}
 */
function parseOperands(argv) {
  const rest = (argv || []).map(String);
  const flagLike = rest.find((a) => a.startsWith('-') && a !== '-');
  if (flagLike) {
    return { file: null, error: 'unexpected option ' + flagLike + ' after the crash file; flags go first, as in `phantom recover --dry-run <file>`' };
  }
  if (rest.length > 1) return { file: null, error: 'phantom recover takes at most one crash file (got ' + rest.length + ')' };
  return { file: rest.length ? rest[0] : null, error: null };
}

/**
 * `phantom recover [--list] [--force] [<file>]`.
 *
 * Wires listCrashes/loadCrash to runRecovery and does nothing else: every
 * decision worth testing lives in those two, and the recovery module is
 * injectable so the wiring can be tested without a Claude session.
 *
 * Never calls process.exit -- the caller returns `exitCode` from main().
 *
 * @param {string[]} argv what followed `recover`, minus phantom's own flags
 * @param {{ cwd?: string, config: Config|null, flags?: object, recovery?: { runRecovery: Function },
 *           hooks?: object, now?: number }} opts
 * @returns {Promise<{ status: string, message: string, exitCode: number, reason?: string, crashes?: CrashEntry[] }>}
 */
async function runReplay(argv = [], opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const flags = opts.flags || {};
  const config = opts.config;
  const now = opts.now || Date.now();
  const bail = (reason, message, hint) => {
    log.error(message);
    if (hint) log.info(hint);
    return { status: 'refused', reason, message, exitCode: 1, reported: true };
  };

  const { file, error } = parseOperands(argv);
  if (error) return bail('usage', error);
  if (flags.list && file) return bail('usage', '--list lists the saved crashes; it does not take a file');
  // PHANTOM_DISABLED is a kill switch for CI and for shells where phantom must
  // stay out of the way. `recover` is an explicit request, but honouring the
  // switch is still the only answer that does not surprise whoever set it.
  if (!config) return bail('disabled', 'PHANTOM_DISABLED is set; unset it to replay a saved crash');

  const root = git.root({ cwd });
  if (!root) return bail('not-a-repo', 'not a git repository; phantom only recovers inside git repos');

  if (flags.list) {
    const entries = listCrashes(root, { reportDir: config.reportDir, now });
    printList(entries, root, crashDirOf(root, config.reportDir), now);
    return { status: 'listed', message: entries.length + ' saved crash(es)', exitCode: 0, crashes: entries };
  }

  const loaded = loadCrash(file, root, { reportDir: config.reportDir, cwd, force: Boolean(flags.force), now });
  if (!loaded.ok) return bail(loaded.reason, loaded.message, loaded.hint);
  for (const w of loaded.warnings) log.warn(w);
  announceReplay(loaded.entry, root, now);

  const recovery = opts.recovery || require('./recovery');
  let outcome;
  try {
    // The context goes through untouched: it is the recovery's only account of
    // what happened, and anything phantom "helpfully" refreshed here would be a
    // description of the present, not of the crash.
    outcome = await recovery.runRecovery(loaded.ctx, config, flags, opts.hooks || {});
  } catch (err) {
    const message = 'recovery failed: ' + (err && err.stack ? err.stack : String(err));
    log.error(message);
    return { status: 'error', reason: 'threw', message, exitCode: 1, reported: true, crashPath: loaded.entry.path };
  }
  if (outcome && outcome.message && !outcome.reported && !BANNERED.has(outcome.status)) {
    log.info(outcome.status + ': ' + outcome.message);
  }
  const status = outcome ? outcome.status : 'error';
  // Exit 0 only when the replay achieved what it was asked for. A refused or
  // still-unfixed replay is a failure to the script that invoked it, even
  // though nothing went wrong with phantom itself.
  return { ...outcome, status, exitCode: status === 'fixed' || status === 'dry-run' ? 0 : 1, crashPath: loaded.entry.path };
}

module.exports = { listCrashes, loadCrash, runReplay, crashDirOf, MAX_AGE_DAYS };
