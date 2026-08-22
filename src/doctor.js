'use strict';

/**
 * `phantom doctor`: the preflight that the first crash currently doubles as.
 *
 * Every check here is already somebody's confusing first run. A claude that is
 * installed but not logged in surfaces mid-recovery as "claude ended with an
 * error" and, historically, nothing after it. A repository with no commits
 * produces two contradictory refusals in a row. A macOS without
 * terminal-notifier accepts --notify, exits 0, and shows nothing. Run before
 * the crash these are one report; run during one they are three surprises
 * arriving while the user is already annoyed.
 *
 * runDoctor() only gathers facts and returns them. renderDoctor() is the only
 * thing that writes, and neither ever exits the process -- the caller owns the
 * exit code, exactly like runRecovery.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig, ConfigError, DEFAULTS } = require('./config');
const git = require('./git');
const ui = require('./ui');
const desktopNotify = require('./desktop-notify');
const { windowsSafeSpawn, killTreeByPid } = require('./watcher');
const { buildClaudeEnv } = require('./prompt');

const { log, colors } = ui;

const PROBE_TIMEOUT_MS = 15000;
const INSTALL_HINT = 'npm install -g @anthropic-ai/claude-code (or set "claudeBin" in .phantomrc)';
const STATUS_LINE_SNIPPET = '"statusLine": { "type": "command", "command": "phantom-status" } in ~/.claude/settings.json';

/**
 * @typedef {object} DoctorCheck
 * @property {string} name
 * @property {'ok'|'warn'|'fail'} status
 * @property {string} detail what phantom found, in the user's terms
 * @property {string|null} fix the one thing to do about it, or null
 */
/**
 * @typedef {object} DoctorResult
 * @property {DoctorCheck[]} checks
 * @property {boolean} ok no check failed; warnings do not sink it
 */

const check = (name, status, detail, fix) => ({ name, status, detail, fix: fix || null });

/** Read and parse a JSON file, or null for missing/unreadable/malformed. */
function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Run one claude probe through the injectable spawn seam.
 *
 * Deliberately mirrors recovery.resolveClaudeBin rather than calling it: that
 * one closes over the real spawnSync and process.cwd(), so a test for this
 * command would only ever pass on a machine that has Claude Code installed and
 * logged in -- which is the machine that does not need a doctor. Same
 * windowsSafeSpawn, same timeout, same wording for the two failure modes.
 *
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, error: string|null }}
 */
function probe(bin, args, { cwd, env, spawn, timeoutMs }) {
  const fail = (error) => ({ ok: false, status: null, stdout: '', stderr: '', error });
  const p = windowsSafeSpawn(bin, args, cwd, env);
  let r;
  try {
    r = spawn(p.file, p.argv, {
      cwd, env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so the tree kill below can reach the children.
      detached: process.platform !== 'win32',
      windowsHide: true,
      ...p.opts,
    });
  } catch (err) {
    return fail(String((err && err.message) || err));
  }
  if (!r) return fail('spawn returned nothing');
  if (r.error) {
    // BEFORE the return, or it never runs. spawnSync's timeout kills the direct
    // child only, and a claudeBin is very often a shim (mise, asdf, volta, npx)
    // that spawns the real binary -- so a probe that timed out left the
    // grandchild running with ppid 1, holding whatever it held.
    killTreeByPid(r.pid);
    return fail(r.error.code === 'ENOENT' ? '"' + bin + '" not found on PATH' : String(r.error.message));
  }
  return { ok: r.status === 0, status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: null };
}

function checkClaudeBin(bin, io) {
  const r = probe(bin, ['--version'], io);
  if (r.error) return { ok: false, check: check('claude binary', 'fail', r.error, INSTALL_HINT) };
  if (!r.ok) {
    const why = (r.stderr || r.stdout || '').trim().split('\n')[0].slice(0, 200);
    return { ok: false, check: check('claude binary', 'fail', '"' + bin + ' --version" exited ' + r.status + (why ? ': ' + why : ''), INSTALL_HINT) };
  }
  const version = r.stdout.trim().split('\n')[0] || '(no version printed)';
  return { ok: true, check: check('claude binary', 'ok', version + (bin === 'claude' ? '' : ' (claudeBin: ' + bin + ')')) };
}

/**
 * Pull the JSON object out of `claude auth status --json` output.
 *
 * Not a bare JSON.parse of the whole stream: claude prints update notices and
 * migration warnings above its own output, and treating "the first line is not
 * JSON" as "you are not logged in" would turn a perfectly healthy install into
 * this command's loudest failure. Anything between the first { and the last }
 * is worth a second attempt.
 */
function parseAuthStatus(raw) {
  const text = String(raw || '').trim();
  const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  try {
    const obj = object(JSON.parse(text));
    if (obj) return obj;
  } catch { /* fall through to the slice */ }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    return object(JSON.parse(text.slice(first, last + 1)));
  } catch {
    return null;
  }
}

/**
 * Can this claude actually authenticate?
 *
 * `claude auth status --json` is the whole probe: it answers in ~0.2s, makes no
 * model call, and costs nothing. That matters because the alternative -- a
 * one-token `claude -p` -- bills the user for a health check, and the state it
 * detects is the single commonest first-run failure there is: Claude Code
 * installed, never logged in. Phantom used to meet that state at the worst
 * possible moment, mid-recovery, as an is_error result whose first line was
 * empty (see the .trim() note in recovery.js).
 *
 * The account's email, org and id are deliberately left out of `detail`: doctor
 * output is written to be pasted into a bug report.
 */
function checkClaudeAuth(bin, io, binOk) {
  const name = 'claude login';
  if (!binOk) return check(name, 'warn', 'not checked: claude itself could not be run', 'fix the claude binary above, then re-run phantom doctor');
  const r = probe(bin, ['auth', 'status', '--json'], io);
  const status = parseAuthStatus(r.stdout);
  const keyNote = io.env.ANTHROPIC_API_KEY
    ? ' · ANTHROPIC_API_KEY is set in this shell and takes precedence over a /login session'
    : '';
  if (status && typeof status.loggedIn === 'boolean') {
    if (!status.loggedIn) {
      return check(name, 'fail',
        'claude is installed but not logged in — a recovery would spend a session to produce one empty error line' + keyNote,
        'run `' + bin + ' auth login` (or start `' + bin + '` once and complete /login)');
    }
    const how = [status.authMethod, status.apiProvider && status.apiProvider !== 'firstParty' ? status.apiProvider : null]
      .filter(Boolean).join(' via ');
    return check(name, 'ok', 'logged in' + (how ? ' (' + how + ')' : '')
      + (status.subscriptionType ? ' · ' + status.subscriptionType : '') + keyNote);
  }
  // No `auth status` subcommand (older Claude Code), or output phantom cannot
  // read. Say what was and was not established rather than guessing: an
  // unverifiable login is a warning, never a failure.
  const why = (r.error || r.stderr || r.stdout || '').trim().split('\n')[0].slice(0, 120);
  return check(name, 'warn',
    'could not verify: `' + bin + ' auth status --json` ' + (r.error ? 'failed' : 'exited ' + r.status) + (why ? ' (' + why + ')' : '')
      + ' — this claude may predate the subcommand. Phantom checked that the binary runs; it did NOT confirm you are logged in' + keyNote,
    'start `' + bin + '` once: if it asks you to log in, phantom would have failed too');
}

function checkGitRepository(root, io) {
  const name = 'git repository';
  if (!io.which('git')) {
    return { root: null, check: check(name, 'fail', 'git is not on PATH; phantom needs it for every part of a recovery', 'install git') };
  }
  if (!root) {
    return {
      root: null,
      check: check(name, 'fail', 'not a git repository; phantom refuses every crash outside one (it needs a branch to work on)',
        'git init && git add -A && git commit -m "initial commit"'),
    };
  }
  const opts = { cwd: root };
  // A linked worktree and a submodule both have a `.git` *file*, not a
  // directory -- the layout that used to make ensureExcluded throw ENOTDIR and
  // leave .phantom/ unexcluded, which in turn made the tree permanently dirty
  // and every recovery a refusal. Both work now, so this only reports.
  const commonDir = git.git(['rev-parse', '--git-common-dir'], opts);
  const gitDir = git.git(['rev-parse', '--git-dir'], opts);
  const superproject = git.git(['rev-parse', '--show-superproject-working-tree'], opts);
  const layout = superproject ? 'submodule of ' + superproject
    : (commonDir && gitDir && path.resolve(root, commonDir) !== path.resolve(root, gitDir)) ? 'linked worktree'
      : null;
  return { root, check: check(name, 'ok', root + (layout ? ' (' + layout + ')' : '')) };
}

function checkGitHistory(root) {
  const name = 'git history';
  if (!root) return check(name, 'warn', 'not checked: there is no repository here');
  const opts = { cwd: root };
  const head = git.headSha(opts);
  if (!head) {
    // The one state that produces two wrong answers in a row. Everything in a
    // fresh `git init` is untracked, so the crash path refuses with "commit,
    // stash, or pass --allow-dirty" -- and two of those three cannot work
    // before the first commit: `git stash` refuses outright in an unborn repo,
    // and --allow-dirty gets as far as step 3 to say "repository has no
    // commits yet", by which point the tree has already been stashed. One
    // commit fixes both, and only this line says so before the crash.
    return check(name, 'fail', 'the repository has no commits yet; phantom branches from HEAD, so there is nothing to branch from',
      'git add -A && git commit -m "initial commit"');
  }
  const branch = git.currentBranch(opts);
  return check(name, 'ok', branch ? branch + ' at ' + head.slice(0, 10) : 'detached HEAD at ' + head.slice(0, 10)
    + ' — phantom will return you to the sha, not a branch');
}

function checkWorkingTree(root) {
  const name = 'working tree';
  if (!root) return check(name, 'warn', 'not checked: there is no repository here');
  const dirty = git.status({ cwd: root });
  if (!dirty) return check(name, 'ok', 'clean');
  const count = dirty.split('\n').filter(Boolean).length;
  return check(name, 'warn', count + ' uncommitted change(s); phantom refuses to recover a dirty tree unless you allow it',
    'commit or stash them before the crash, or wrap the command with --allow-dirty (phantom stashes them first and restores them after)');
}

/**
 * What `phantom` would run to verify a patch.
 *
 * Mirrors recovery.resolveTestCommand minus its middle layer: that one also
 * accepts a command detected from the crash itself (ctx.testCommand), which
 * cannot exist before there is a crash. So a repo with neither config nor an
 * npm test script may still get a test command on the day -- worth saying,
 * because "none" here is a warning, not a verdict.
 */
function resolveTestCommand(root, config) {
  if (config.testCommand) return { command: config.testCommand, source: 'config' };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root || '.', 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.test) return { command: 'npm test', source: 'package.json "scripts.test"' };
  } catch { /* no package.json */ }
  return { command: null, source: null };
}

function checkTestCommand(root, config, io) {
  const name = 'test command';
  const { command, source } = resolveTestCommand(root, config);
  if (!command) {
    return check(name, 'warn',
      'none: no "testCommand" in .phantomrc and no "test" script in package.json — phantom can patch, but it cannot verify the patch',
      'add a test script, or set "testCommand" in .phantomrc');
  }
  const first = String(command).trim().split(/\s+/)[0];
  // Phantom runs the test command through a shell, so a builtin, a function or
  // an alias resolved at run time is legitimate and PATH cannot see it. Only
  // the plain "you named a program that does not exist" case is worth a word,
  // and even that is a warning.
  const shellish = /[|&;<>(){}$`]/.test(first) || first.includes('=');
  const resolved = shellish ? null : io.which(first);
  if (!shellish && !resolved) {
    return check(name, 'warn', command + ' (from ' + source + '), but "' + first + '" is not on PATH',
      'install it, or point "testCommand" at something this shell can run');
  }
  return check(name, 'ok', command + ' (from ' + source + ')' + (resolved ? ' · ' + first + ' at ' + resolved : ''));
}

function checkNotifications(config, io) {
  const name = 'notifications';
  const state = config.notify === true ? 'notify is on' : 'off until you pass --notify (or set "notify": true)';
  if (io.platform === 'darwin') {
    const bin = io.which('terminal-notifier');
    if (bin) return check(name, 'ok', 'terminal-notifier at ' + bin + ' · ' + state);
    // announce.js warns about this too, but only after a notification has
    // already been silently swallowed. macOS 14+ drops `display notification`
    // from a plain CLI without ever listing it under System Settings, and
    // osascript still exits 0 -- so there is nothing phantom can observe at
    // send time to tell delivery from a black hole. Saying it here is the only
    // chance to say it before the user trusts it.
    return check(name, 'warn',
      'terminal-notifier is not installed, so --notify falls back to AppleScript — macOS 14+ drops those silently and osascript still exits 0, '
        + 'so nothing arrives and phantom cannot tell · ' + state,
      'brew install terminal-notifier');
  }
  if (io.platform === 'linux') {
    const bin = io.which('notify-send');
    if (bin) return check(name, 'ok', 'notify-send at ' + bin + ' · ' + state);
    return check(name, 'warn', 'notify-send is not installed; --notify is skipped entirely · ' + state,
      'install libnotify (apt install libnotify-bin)');
  }
  return check(name, 'warn', 'desktop notifications are not supported on ' + io.platform + '; --notify is skipped entirely',
    'set "webhook" in .phantomrc to be told another way');
}

/** User, then project: the files Claude Code merges, in the order it merges them. */
function settingsFiles(root, io) {
  const dirs = [...new Set([path.join(io.home, '.claude'), path.join(root || io.cwd, '.claude')])];
  const files = [];
  for (const dir of dirs) {
    files.push(path.join(dir, 'settings.json'));
    files.push(path.join(dir, 'settings.local.json'));
  }
  return files.map((file) => ({ file, data: readJson(file) })).filter((s) => s.data);
}

function checkStatusLine(settings) {
  const name = 'status line';
  const configured = settings.filter((s) => s.data.statusLine && typeof s.data.statusLine === 'object');
  const wired = configured.find((s) => String(s.data.statusLine.command || '').includes('phantom-status'));
  if (wired) return check(name, 'ok', 'phantom-status is wired in ' + wired.file);
  if (configured.length) {
    const other = configured[0];
    return check(name, 'warn',
      other.file + ' already runs a status line (' + String(other.data.statusLine.command || other.data.statusLine.type).slice(0, 60)
        + '), so phantom has nowhere to print "fixing…"',
      'chain both: copy examples/statusline.sh, set BASE to your current command, and point statusLine.command at it');
  }
  return check(name, 'warn', 'not configured; phantom recovers in the background with nothing on screen to say so',
    'add ' + STATUS_LINE_SNIPPET);
}

function checkPlugin(settings, io) {
  const name = 'claude code plugin';
  const enabled = settings.some((s) => s.data.enabledPlugins && typeof s.data.enabledPlugins === 'object'
    && Object.keys(s.data.enabledPlugins).some((k) => /^phantom@/.test(k) && s.data.enabledPlugins[k]));
  const installed = (() => {
    const data = readJson(path.join(io.home, '.claude', 'plugins', 'installed_plugins.json'));
    const plugins = data && data.plugins;
    return Boolean(plugins && typeof plugins === 'object' && Object.keys(plugins).some((k) => /^phantom@/.test(k)));
  })();
  if (enabled) return check(name, 'ok', 'installed and enabled; crashes are reported into your next Claude Code turn');
  if (installed) {
    return check(name, 'warn', 'installed but not enabled, so the crash briefings and /phantom:recover are not loaded',
      'enable it with /plugin, then restart Claude Code');
  }
  return check(name, 'warn', 'not installed; phantom still recovers, but nothing tells the Claude Code session it happened',
    '/plugin marketplace add waazy-w/claude-phantom then /plugin install phantom@claude-phantom (or run claude --plugin-dir <repo>/plugin)');
}

function checkConfig(config, configError) {
  const name = 'config';
  if (configError) {
    // Every phantom-wrapped command in this directory already exits 2 without
    // running -- including the one the user is about to wrap.
    return check(name, 'fail', configError.message + ' — until this parses, phantom refuses to run any command here',
      'fix or delete the file above');
  }
  const from = config.loadedFrom && config.loadedFrom.length ? config.loadedFrom.join(', ') : null;
  const notes = [];
  if (Number(config.maxMinutes) < 5) notes.push('maxMinutes is ' + config.maxMinutes + ', which few real sessions finish inside');
  if (config.webhook && /^http:\/\//i.test(config.webhook)) notes.push('webhook is plain http, so the crash summary travels in clear');
  if (config.keepReports === 0) notes.push('keepReports is 0, so nothing under .phantom/ is ever pruned');
  const where = from ? 'loaded from ' + from : 'defaults only (no .phantomrc, no package.json "phantom" field)';
  if (!notes.length) return check(name, 'ok', where);
  return check(name, 'warn', where + ' · ' + notes.join('; '), 'edit ' + (from || '.phantomrc'));
}

/**
 * Gather every preflight fact. Never writes, never exits.
 *
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, platform?: string, home?: string,
 *           spawn?: typeof spawnSync, which?: (bin: string) => string|null,
 *           overrides?: object, timeoutMs?: number }} [opts] I/O seams; the defaults are the real machine
 * @returns {DoctorResult}
 */
function runDoctor(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const io = {
    cwd,
    // The same environment recovery hands the session (CLAUDECODE and
    // CLAUDE_CODE_ENTRYPOINT stripped), so a doctor run from inside a Claude
    // Code session probes the claude that a recovery would actually spawn.
    env: buildClaudeEnv(env),
    platform: opts.platform || process.platform,
    home: opts.home || os.homedir(),
    spawn: opts.spawn || spawnSync,
    which: opts.which || ((bin) => desktopNotify.which(bin, env)),
    timeoutMs: opts.timeoutMs > 0 ? opts.timeoutMs : PROBE_TIMEOUT_MS,
  };

  let config = null;
  let configError = null;
  try {
    // `env` matters here: without it the environment layer comes from
    // process.env regardless of what the caller injected, so doctor would
    // report a different config from the one a wrapped command would get --
    // and every test that injects an env would be testing the wrong thing.
    config = loadConfig(cwd, opts.overrides || {}, { env, configPath: opts.configPath });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    configError = err;
    // Keep checking with the defaults: a broken .phantomrc must not hide the
    // other five answers the user came here for.
    config = { ...DEFAULTS, loadedFrom: [] };
  }

  const repo = checkGitRepository(git.root({ cwd }), io);
  const bin = config.claudeBin || 'claude';
  const claude = checkClaudeBin(bin, io);
  const settings = settingsFiles(repo.root, io);
  const checks = [
    claude.check,
    checkClaudeAuth(bin, io, claude.ok),
    repo.check,
    checkGitHistory(repo.root),
    checkWorkingTree(repo.root),
    checkTestCommand(repo.root || cwd, config, io),
    checkNotifications(config, io),
    checkStatusLine(settings),
    checkPlugin(settings, io),
    checkConfig(config, configError),
  ];
  return { checks, ok: !checks.some((c) => c.status === 'fail') };
}

// ✅ and ❌ are two terminal columns wide, ⚠ is one (see ui.charWidth), so the
// warning rows would hang a column left of every other row without the pad.
const MARKS = { ok: () => colors.green('✅'), warn: () => colors.yellow('⚠') + ' ', fail: () => colors.red('❌') };

/**
 * Print a doctor result to stderr, in phantom's voice.
 * @param {DoctorResult} result
 */
function renderDoctor(result) {
  const checks = (result && result.checks) || [];
  const width = checks.reduce((w, c) => Math.max(w, c.name.length), 0);
  for (const c of checks) {
    log.info((MARKS[c.status] || MARKS.warn)() + ' ' + colors.bold(c.name.padEnd(width)) + '  ' + c.detail);
    // The fix is the only actionable half of a bad row, so it never scrolls
    // away with the detail: one indented line, immediately under its check.
    if (c.fix && c.status !== 'ok') log.info('   ' + ' '.repeat(width + 2) + colors.dim('↳ ' + c.fix));
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const tally = [counts.ok + ' ok', counts.warn ? counts.warn + ' warning' + (counts.warn === 1 ? '' : 's') : null,
    counts.fail ? counts.fail + ' problem' + (counts.fail === 1 ? '' : 's') : null].filter(Boolean).join(' · ');
  const lines = [colors.bold('👻 phantom doctor') + colors.dim(' · ' + tally)];
  lines.push(result && result.ok
    ? 'phantom is ready; wrap a command with `phantom <cmd>` and forget about it'
    : 'phantom would refuse or fail on a crash right now — fix the ❌ rows above');
  if (result && result.ok && counts.warn) lines.push(colors.dim('the warnings are optional polish, not blockers'));
  ui.banner(lines, { color: result && result.ok ? colors.green : colors.red });
}

module.exports = { runDoctor, renderDoctor, parseAuthStatus, resolveTestCommand };
