'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('./config');
const { runCommand, exitCodeFor, SpawnError } = require('./watcher');
const { detectCrash, summarizeExit } = require('./crash');
const { gatherContext } = require('./context');
const ui = require('./ui');
const announce = require('./announce');

const { log, colors } = ui;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const VALUE_FLAGS = {
  '--test': 'test',
  '--max-iterations': 'maxIterations',
  '--max-minutes': 'maxMinutes',
  '--model': 'model',
  '--webhook': 'webhook',
  '--config': 'config',
};

/**
 * Boolean flags, and the value each one sets.
 *
 * Every boolean is negatable in both directions on purpose. The old table only
 * had the "on" half of each pair, and overrides were emitted only when a flag
 * was truthy -- so once a `.phantomrc` set `notify: true`, `autoCommit: true`
 * or `promptOnFinish: true`, there was no way to turn it off for a single run
 * without editing the file. A config you cannot override from the command line
 * is a config that makes people edit files they did not want to change.
 */
const BOOL_FLAGS = {
  '--dry-run': ['dryRun', true],
  '--allow-dirty': ['allowDirty', true],
  '--no-commit': ['noCommit', true],
  '--commit': ['noCommit', false],
  '--no-prompt': ['noPrompt', true],
  '--prompt': ['noPrompt', false],
  '--notify': ['notify', true],
  '--no-notify': ['notify', false],
  '--verify': ['verifyCommand', true],
  '--no-verify': ['verifyCommand', false],
  '--verbose': ['verbose', true],
  '--version': ['version', true],
  '-V': ['version', true],
  '--help': ['help', true],
  '-h': ['help', true],
  // `phantom recover` only; harmless elsewhere, and keeping them in the one
  // table means the subcommand reuses the same parser rather than a second one.
  '--list': ['list', true],
  '--force': ['force', true],
};

/**
 * @typedef {object} Flags
 * @property {boolean} dryRun
 * @property {boolean} allowDirty
 * @property {string|null} test
 * @property {number|null} maxIterations
 * @property {number|null} maxMinutes
 * @property {string|null} model
 * @property {boolean} noCommit
 * @property {boolean} notify
 * @property {boolean} verbose
 * @property {boolean} version
 * @property {boolean} help
 */

/**
 * Phantom's own verbs, dispatched before the wrapped-command parsing.
 *
 * `parseArgs` exists to split phantom's flags from the program it wraps, so it
 * would eat `--dry-run` as phantom's own and reject `--older-than` outright --
 * neither would ever reach `clean`. Checking argv[0] first leaves the escape
 * hatch intact: `phantom -- ls -la` has `--` at argv[0], so it still wraps the
 * real `ls`.
 */
const SUBCOMMANDS = new Set(['doctor', 'ls', 'clean', 'recover']);

function defaultFlags() {
  // The tri-state booleans start as null, not false: "not mentioned" has to be
  // distinguishable from "explicitly turned off", or `--no-notify` cannot beat
  // a config file that turned it on.
  return {
    dryRun: false, allowDirty: false, test: null, maxIterations: null, maxMinutes: null,
    model: null, webhook: null, config: null, noCommit: null, noPrompt: null, notify: null,
    verifyCommand: null, verbose: false, version: false, help: false, list: false, force: false,
  };
}

function parseInteger(flag, raw) {
  if (!/^\d+$/.test(String(raw))) throw new UsageError(flag + ' expects a whole number, got "' + raw + '"');
  return Number(raw);
}

/**
 * Phantom flags come before the command; the first non-flag token (or the
 * token after `--`) starts the wrapped command and everything after it is
 * passed through verbatim.
 * @param {string[]} argv arguments without the node/script prefix
 * @returns {{ flags: Flags, command: string|null, args: string[] }}
 */
function parseArgs(argv) {
  const flags = defaultFlags();
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === '--') { i++; break; }
    if (!tok.startsWith('-') || tok === '-') break;
    let name = tok;
    let inlineValue;
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq !== -1) {
      name = tok.slice(0, eq);
      inlineValue = tok.slice(eq + 1);
    }
    if (name in BOOL_FLAGS) {
      if (inlineValue !== undefined) throw new UsageError(name + ' does not take a value');
      const [key, value] = BOOL_FLAGS[name];
      flags[key] = value;
      i++;
      continue;
    }
    if (name in VALUE_FLAGS) {
      const value = inlineValue !== undefined ? inlineValue : argv[i + 1];
      if (value === undefined) throw new UsageError(name + ' requires a value');
      const key = VALUE_FLAGS[name];
      flags[key] = key === 'maxIterations' || key === 'maxMinutes' ? parseInteger(name, value) : value;
      i += inlineValue !== undefined ? 1 : 2;
      continue;
    }
    throw new UsageError('unknown option ' + tok + ' (see phantom --help)');
  }
  const command = i < argv.length ? argv[i] : null;
  return { flags, command, args: argv.slice(i + 1) };
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function helpText() {
  return [
    'Usage: phantom [flags] [--] <command> [args...]',
    '',
    'Runs <command> untouched. If it exits non-zero or dies from a signal (not your',
    'own Ctrl+C), phantom captures the crash and runs a headless Claude Code session',
    'to diagnose and fix it on a phantom/fix-* branch. The original exit code is kept.',
    '',
    'Subcommands:',
    '  phantom doctor        check everything a recovery needs, before your first crash',
    '  phantom ls            list this repo\'s crash captures, post-mortems and fix branches',
    '  phantom clean         prune merged phantom/fix-* branches and old captures',
    '  phantom recover       replay a saved crash without waiting for it to happen again',
    '',
    'Flags:',
    '  --dry-run             diagnose and propose a diff; never change the working tree',
    '  --allow-dirty         recover even with uncommitted changes (stashes them first)',
    '  --test <cmd>          verification command (default: "npm test" when defined)',
    '  --max-iterations <n>  fix/verify loop cap, 1-10 (default 3)',
    '  --max-minutes <n>     wall-clock cap for recovery, 1-120 (default 15)',
    '  --model <m>           model passed to claude --model',
    '  --webhook <url>       POST a JSON summary when recovery ends',
    '  --config <path>       use this config file instead of searching for one',
    '  --no-commit           leave the fix uncommitted on the phantom branch',
    '  --no-prompt           never ask whether to merge or delete the fix branch',
    '  --notify              desktop notification on crash and when recovery ends',
    '  --no-verify           skip re-running the crashed command after the tests pass',
    '  --verbose             stream Claude progress and phantom debug output',
    '  --version, -V         print version',
    '  --help, -h            print this help',
    '',
    'Every boolean flag negates, so a setting in your config file can be turned off',
    'for a single run: --commit, --prompt, --no-notify, --verify.',
    '',
    'Everything after the command is passed through verbatim, so',
    '  phantom npm run dev --verbose',
    'gives --verbose to npm, not phantom. Use --verbose before the command for phantom.',
    '',
    'Env: PHANTOM_DISABLED=1 makes phantom a pure passthrough. Settings can also come',
    'from PHANTOM_TEST, PHANTOM_MODEL, PHANTOM_MAX_ITERATIONS, PHANTOM_MAX_MINUTES,',
    'PHANTOM_WEBHOOK, PHANTOM_CLAUDE_BIN, PHANTOM_REPORT_DIR, PHANTOM_KEEP_REPORTS,',
    'PHANTOM_NOTIFY, PHANTOM_AUTO_COMMIT, PHANTOM_PROMPT_ON_FINISH, PHANTOM_VERIFY_COMMAND.',
    '',
    'Config: .phantomrc (JSON) or the "phantom" field of package.json, looked for in',
    'the current directory first and then at the git root; first hit wins.',
    'Precedence: flags > environment > config file > defaults.',
  ].join('\n');
}

function flagsToOverrides(flags) {
  // `undefined` means "not set on the command line", so the layer below wins.
  // The negatable booleans map through their tri-state: null passes through,
  // true and false are both real overrides. Emitting an override only when a
  // flag was truthy is what made the config one-way.
  const pass = (v) => (v === null ? undefined : v);
  return {
    testCommand: pass(flags.test),
    maxIterations: pass(flags.maxIterations),
    maxMinutes: pass(flags.maxMinutes),
    model: pass(flags.model),
    webhook: pass(flags.webhook),
    autoCommit: flags.noCommit === null ? undefined : !flags.noCommit,
    promptOnFinish: flags.noPrompt === null ? undefined : !flags.noPrompt,
    notify: pass(flags.notify),
    verifyCommand: pass(flags.verifyCommand),
  };
}

/**
 * Run one of phantom's own verbs. Each module owns its flag parsing and returns
 * an exit code; none of them call process.exit, so they stay testable.
 */
async function runSubcommand(name, rest, { cwd, env, io }) {
  const out = io.stdout || process.stdout;
  // Checked for EVERY subcommand, before anything is loaded or spawned.
  // `phantom recover --help` used to reach runReplay and start a real headless
  // session -- stashing, branching, patching, spending -- because the recover
  // branch parsed the flags and then never looked at them.
  if (rest.includes('--help') || rest.includes('-h')) { out.write(subcommandHelp(name) + '\n'); return 0; }
  if (rest.includes('--version') || rest.includes('-V')) { out.write(readVersion() + '\n'); return 0; }
  // The documented kill switch says phantom becomes a pure passthrough. It has
  // to cover the one subcommand that spends money; the check lived inside
  // replay.js behind a `config` that the CLI always supplied, so it was
  // unreachable from the command line.
  if (env.PHANTOM_DISABLED !== undefined && env.PHANTOM_DISABLED !== '' && env.PHANTOM_DISABLED !== '0') {
    log.warn('PHANTOM_DISABLED is set; phantom ' + name + ' does nothing');
    return 0;
  }

  if (name === 'doctor') {
    // doctor took no arguments at all, so `--bogus` was accepted silently while
    // ls and clean both reject one. Consistency matters most on the command a
    // confused user reaches for first.
    const unknown = rest.filter((a) => a.startsWith('-'));
    if (unknown.length) { log.error('unknown option ' + unknown[0] + ' (see phantom doctor --help)'); return 2; }
    const doctor = io.doctor || require('./doctor');
    // doctor loads its own config, leniently -- a broken .phantomrc is one of
    // the things it exists to report, so it must not stop doctor from running.
    // Loading it here as well and passing it in was dead weight: runDoctor
    // never read the parameters, and the two copies could disagree.
    const result = doctor.runDoctor({ cwd, env });
    doctor.renderDoctor(result);
    return result.ok ? 0 : 1;
  }
  if (name === 'ls' || name === 'clean') {
    const manage = io.manage || require('./manage');
    return await manage.runSubcommand(name, rest, { cwd });
  }
  // recover
  const replay = io.replay || require('./replay');
  const parsed = parseArgs(rest);
  const config = loadConfig(cwd, flagsToOverrides(parsed.flags), { env, configPath: parsed.flags.config });
  const res = await replay.runReplay(
    parsed.command === null ? [] : [parsed.command, ...parsed.args],
    { cwd, config, flags: parsed.flags, recovery: io.recovery },
  );
  // A mistyped invocation exits 2 like every other usage error, so a script can
  // tell "you typed it wrong" apart from "the replay did not fix it" (also 1).
  return res.reason === 'usage' ? 2 : res.exitCode;
}

/** Help for one of phantom's own verbs. ls/clean own theirs; the rest live here. */
function subcommandHelp(name) {
  if (name === 'ls' || name === 'clean') {
    const manage = require('./manage');
    return name === 'ls' ? manage.lsHelp() : manage.cleanHelp();
  }
  if (name === 'doctor') {
    return [
      'Usage: phantom doctor',
      '',
      'Checks everything a recovery needs, before your first crash: that claude is',
      'installed and logged in, that this is a git repository with at least one commit,',
      'what test command phantom would run, whether desktop notifications can reach you,',
      'and whether the status line and Claude Code plugin are wired up.',
      '',
      'Exits 0 when nothing failed (warnings are fine), 1 when something would stop a',
      'recovery. Takes no options.',
    ].join('\n');
  }
  return [
    'Usage: phantom recover [flags] [<crash.json>]',
    '',
    'Replays a crash phantom already captured, without waiting for the command to',
    'crash again -- for retrying a recovery that was refused because the tree was',
    'dirty or claude was missing. Uses the newest capture in .phantom/crashes/',
    'unless you name one.',
    '',
    '  --list                list the saved crashes, newest first, and stop',
    '  --force               replay a capture phantom judged too old or off-base',
    '  --dry-run             diagnose only; no branch, no edits',
    '  --no-prompt           do not ask whether to merge or delete the fix branch',
    '',
    'Flags go before the file. The test command recorded in a capture is ignored:',
    'phantom resolves it from your config, so a saved file cannot choose what runs.',
  ].join('\n');
}

/**
 * The command that clears this refusal.
 *
 * Rust's panic handler prints the literal `RUST_BACKTRACE=1` at the point of
 * failure rather than describing it, and phantom already does this well
 * elsewhere -- doctor's indented fix lines, the full-sha stash command. These
 * three messages named the problem and left the user to work out the cure.
 */
function retryHint(refusal) {
  if (/uncommitted changes/.test(refusal)) return 'commit or stash, then: phantom recover';
  if (/not a git repository/.test(refusal)) return 'phantom only recovers inside git repos: git init && git commit';
  if (/nothing to diagnose/.test(refusal)) return "give it something to verify against: phantom --test '<your test command>' <cmd>, or diagnose only with phantom --dry-run <cmd>";
  return 'once that is resolved: phantom recover';
}

function describeCommand(command, args) {
  return [command, ...args].join(' ');
}

/**
 * @param {string[]} [argv] defaults to process.argv.slice(2)
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream,
 *           recovery?: { runRecovery: Function } }} [io] test hooks; recovery overrides require('./recovery')
 * @returns {Promise<number>} exit code for the process
 */
/** Statuses whose outcome the recovery banner already states in full. */
const BANNERED = new Set(['fixed', 'unfixed', 'dry-run', 'timeout', 'aborted']);

async function main(argv = process.argv.slice(2), io = {}) {
  const cwd = io.cwd || process.cwd();
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;

  // A subcommand placed after phantom's flags is a mistake worth naming rather
  // than acting on: `phantom --verbose ls` used to run /bin/ls silently, and
  // `phantom --dry-run recover` died with "command not found: recover". Both
  // look like phantom commands and neither behaves like one.
  const misplaced = argv.findIndex((a) => SUBCOMMANDS.has(a));
  if (misplaced > 0 && argv[0] !== '--' && argv[0].startsWith('-')) {
    log.error('phantom ' + argv[misplaced] + ' is a subcommand, so it goes first: '
      + 'phantom ' + argv[misplaced] + ' ' + argv.filter((a, i) => i !== misplaced).join(' '));
    log.error('to wrap a program of that name instead, use: phantom -- ' + argv.slice(misplaced).join(' '));
    return 2;
  }

  if (SUBCOMMANDS.has(argv[0])) {
    try {
      return await runSubcommand(argv[0], argv.slice(1), { cwd, env, io });
    } catch (err) {
      if (err instanceof ConfigError || err instanceof UsageError) { log.error(err.message); return 2; }
      log.error((err && err.stack) ? err.stack : String(err));
      return 1;
    }
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    log.error(err.message);
    return 2;
  }
  const { flags, command, args } = parsed;
  if (flags.help) { out.write(helpText() + '\n'); return 0; }
  if (flags.version) { out.write(readVersion() + '\n'); return 0; }
  if (!command) {
    log.error('no command given');
    process.stderr.write(helpText() + '\n');
    return 2;
  }
  log.setVerbose(flags.verbose);

  const disabled = env.PHANTOM_DISABLED !== undefined && env.PHANTOM_DISABLED !== '' && env.PHANTOM_DISABLED !== '0';
  let config = null;
  if (!disabled) {
    try {
      config = loadConfig(cwd, flagsToOverrides(flags), { env, configPath: flags.config });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      log.error('config error: ' + err.message);
      return 2;
    }
    if (config.loadedFrom.length) log.verbose('config loaded from ' + config.loadedFrom.join(', '));
  } else {
    log.verbose('PHANTOM_DISABLED set: passthrough only');
  }

  let result;
  try {
    result = await runCommand(command, args, {
      cwd,
      env,
      ringBufferBytes: config ? config.ringBufferBytes : 4096,
      stdout: io.stdout,
      stderr: io.stderr,
    });
  } catch (err) {
    if (!(err instanceof SpawnError)) throw err;
    log.error(err.message);
    return err.exitCode;
  }

  const childExit = exitCodeFor(result);
  if (disabled || !detectCrash(result)) {
    if (result.userInterrupted) log.verbose('interrupted by user; skipping recovery');
    return childExit;
  }

  const ctx = gatherContext(result, config);
  // A non-zero exit with no error line, no stack trace, no file named in the
  // output and no test command leaves the session nothing to work from: it can
  // neither locate the fault nor tell whether it fixed it. Observed on a bare
  // `process.exit(7)` -- 90 seconds and ~300k tokens to conclude nothing, which
  // is the shape of a linter or build tool that just exits non-zero. Spending a
  // session to reliably achieve nothing is worse than declining, so phantom says
  // what it is missing and stops. --dry-run still runs, since a diagnosis with
  // no verification is exactly what that mode is for.
  const nothingToGoOn = !ctx.errorLine && !ctx.stackTrace && !ctx.hintFiles.length
    && !ctx.testCommand && !flags.dryRun && !result.signal;
  const refusal = !ctx.git
    ? 'not a git repository'
    : ctx.git.dirty && !flags.allowDirty && !flags.dryRun
      ? 'uncommitted changes in the working tree (commit, stash, or pass --allow-dirty)'
      : nothingToGoOn ? 'no error output and no test command — nothing to diagnose or verify against' : null;
  // Announce only what phantom is actually going to do. This used to run before
  // the refusal check, so a crash phantom explicitly DECLINED to recover still
  // appended a crash event -- and since no recovery event ever follows, both
  // readers treat it as work in progress: the status line shows "fixing <cmd>…"
  // for the full 20-minute window, and the plugin briefs Claude to go looking
  // for a fix branch that was never created.
  if (refusal) {
    log.warn(describeCommand(command, args) + ' crashed (' + summarizeExit(result) + '); phantom is not recovering: ' + refusal);
    // Save the crash even though we are declining to act on it, so `phantom
    // recover` can do the two things its help text promises. Without this, the
    // context for a flaky crash is gone the moment the user commits.
    // The injected recovery seam only has to provide runRecovery -- tests stub
    // it with exactly that -- so fall through to the real module for capture.
    const rec = io.recovery && io.recovery.captureCrash ? io.recovery : require('./recovery');
    const saved = ctx.git ? rec.captureCrash(ctx, config) : null;
    if (saved) {
      log.warn('crash saved to ' + path.relative(cwd, saved).replace(/\\/g, '/'));
      log.warn('  ' + retryHint(refusal));
    }
    return childExit;
  }
  if (ctx.git) await announce.announceCrash(ctx, config, ctx.git.root);
  const lines = [
    colors.bold('⚠ ' + describeCommand(command, args) + ' crashed (' + summarizeExit(result) + ') — phantom is taking over'),
  ];
  if (ctx.errorLine) lines.push(colors.red(ctx.errorLine));
  if (ctx.hintFiles.length) lines.push(colors.dim('hint files: ' + ctx.hintFiles.slice(0, 5).join(', ')));
  if (flags.dryRun) lines.push(colors.dim('dry run: the working tree will not be modified'));
  ui.banner(lines, { color: colors.red });

  let recovery = io.recovery;
  try {
    if (!recovery) recovery = require('./recovery');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /recovery/.test(err.message)) {
      log.warn('recovery module missing; exiting with the child exit code');
      return childExit;
    }
    throw err;
  }
  try {
    const outcome = await recovery.runRecovery(ctx, config, flags);
    // The banner printed by runRecovery already carries the status and message,
    // and it is the last thing the user reads. Repeating it here put the same
    // sentence on screen twice, every run. Only statuses that never reach the
    // banner -- the early refusals and errors -- still need a line of their own.
    if (outcome && outcome.message && !outcome.reported && !BANNERED.has(outcome.status)) {
      log.info(outcome.status + ': ' + outcome.message);
    }
  } catch (err) {
    log.error('recovery failed: ' + (err && err.stack ? err.stack : err));
  }
  // The wrapped command did crash. Even when the fix landed on a phantom branch
  // the user's tree is unchanged, so CI and scripts must still see the failure.
  return childExit;
}

module.exports = { parseArgs, helpText, main, UsageError, flagsToOverrides };
