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

const VALUE_FLAGS = { '--test': 'test', '--max-iterations': 'maxIterations', '--max-minutes': 'maxMinutes', '--model': 'model' };
const BOOL_FLAGS = {
  '--dry-run': 'dryRun',
  '--allow-dirty': 'allowDirty',
  '--no-commit': 'noCommit',
  '--notify': 'notify',
  '--verbose': 'verbose',
  '--version': 'version',
  '-V': 'version',
  '--help': 'help',
  '-h': 'help',
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

function defaultFlags() {
  return {
    dryRun: false, allowDirty: false, test: null, maxIterations: null, maxMinutes: null,
    model: null, noCommit: false, notify: false, verbose: false, version: false, help: false,
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
      flags[BOOL_FLAGS[name]] = true;
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
    'Flags:',
    '  --dry-run             diagnose and propose a diff; never change the working tree',
    '  --allow-dirty         recover even with uncommitted changes (stashes them first)',
    '  --test <cmd>          verification command (default: "npm test" when defined)',
    '  --max-iterations <n>  fix/verify loop cap, 1-10 (default 3)',
    '  --max-minutes <n>     wall-clock cap for recovery, 1-120 (default 15)',
    '  --model <m>           model passed to claude --model',
    '  --no-commit           leave the fix uncommitted on the phantom branch',
    '  --notify              desktop notification on crash and when recovery ends',
    '  --verbose             stream Claude progress and phantom debug output',
    '  --version             print version',
    '  --help                print this help',
    '',
    'Everything after the command is passed through verbatim, so',
    '  phantom npm run dev --verbose',
    'gives --verbose to npm, not phantom. Use --verbose before the command for phantom.',
    '',
    'Env: PHANTOM_DISABLED=1 makes phantom a pure passthrough.',
    'Config: .phantomrc (JSON) or the "phantom" field of package.json.',
  ].join('\n');
}

function flagsToOverrides(flags) {
  return {
    testCommand: flags.test === null ? undefined : flags.test,
    maxIterations: flags.maxIterations === null ? undefined : flags.maxIterations,
    maxMinutes: flags.maxMinutes === null ? undefined : flags.maxMinutes,
    model: flags.model === null ? undefined : flags.model,
    autoCommit: flags.noCommit ? false : undefined,
    notify: flags.notify ? true : undefined,
  };
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
async function main(argv = process.argv.slice(2), io = {}) {
  const cwd = io.cwd || process.cwd();
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
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
      config = loadConfig(cwd, flagsToOverrides(flags));
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
  const refusal = !ctx.git
    ? 'not a git repository'
    : ctx.git.dirty && !flags.allowDirty && !flags.dryRun ? 'uncommitted changes in the working tree (commit, stash, or pass --allow-dirty)' : null;
  if (ctx.git) await announce.announceCrash(ctx, config, ctx.git.root);
  if (refusal) {
    log.warn(describeCommand(command, args) + ' crashed (' + summarizeExit(result) + '); phantom is not recovering: ' + refusal);
    return childExit;
  }
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
    if (outcome && outcome.message) log.info(outcome.status + ': ' + outcome.message);
  } catch (err) {
    log.error('recovery failed: ' + (err && err.stack ? err.stack : err));
  }
  // The wrapped command did crash. Even when the fix landed on a phantom branch
  // the user's tree is unchanged, so CI and scripts must still see the failure.
  return childExit;
}

module.exports = { parseArgs, helpText, main, UsageError, flagsToOverrides };
