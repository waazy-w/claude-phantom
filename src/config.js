'use strict';

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');

/**
 * @typedef {object} Config
 * @property {string|null} testCommand
 * @property {number} maxIterations
 * @property {number} maxMinutes
 * @property {string[]} neverTouch user globs merged with alwaysNeverTouch
 * @property {string[]} alwaysNeverTouch
 * @property {string|null} webhook
 * @property {boolean} notify desktop notification on crash and when recovery ends
 * @property {string|null} model
 * @property {boolean} autoCommit
 * @property {boolean} promptOnFinish ask whether to merge or delete the fix branch (interactive TTY only)
 * @property {boolean} verifyCommand re-run the crashed command after the tests pass
 * @property {string} reportDir
 * @property {number} ringBufferBytes
 * @property {string} claudeBin
 */

const ALWAYS_NEVER_TOUCH = Object.freeze(['.git/**', 'node_modules/**']);

const DEFAULTS = Object.freeze({
  testCommand: null,
  maxIterations: 3,
  maxMinutes: 15,
  // maxIterations and maxMinutes bound how often phantom asks and how long it
  // waits; neither bounds what it SPENDS -- one iteration on a large repo can
  // cost more than three on a small one, which is why the FAQ's "how much does
  // it cost?" answer was unsatisfying. null means no ceiling, so nothing
  // changes for anyone who does not set one. Price table lives in src/budget.js.
  maxTokens: null,
  maxCostUsd: null,
  neverTouch: Object.freeze(['.env', '.env.*', '**/*.pem', '**/*.key', '**/secrets/**', '**/*.secret*']),
  webhook: null,
  notify: false,
  model: null,
  autoCommit: true,
  promptOnFinish: true,
  verifyCommand: true,
  reportDir: '.phantom/reports',
  ringBufferBytes: 262144,
  claudeBin: 'claude',
  // How many crash JSONs and post-mortems to keep per repo. Nothing pruned
  // these, so a month of a crashy dev loop left hundreds of files -- each crash
  // JSON carrying the full context, tail included, up to ringBufferBytes. 0
  // disables pruning for anyone who wants the whole history.
  keepReports: 50,
});

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError('could not parse ' + label + ' (' + file + '): ' + err.message);
  }
}

function findRc(dirs) {
  for (const dir of dirs) {
    const file = path.join(dir, '.phantomrc');
    const data = readJson(file, '.phantomrc');
    if (data !== null) return { file, data };
  }
  return null;
}

function findPkgField(dirs) {
  for (const dir of dirs) {
    const file = path.join(dir, 'package.json');
    const data = readJson(file, 'package.json');
    if (data && data.phantom !== undefined) return { file, data: data.phantom };
  }
  return null;
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(label + ' must be a JSON object');
  }
}

function validate(cfg) {
  const int = (key, min, max) => {
    const v = cfg[key];
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new ConfigError(key + ' must be an integer between ' + min + ' and ' + max + ' (got ' + JSON.stringify(v) + ')');
    }
  };
  const strOrNull = (key) => {
    const v = cfg[key];
    if (v !== null && (typeof v !== 'string' || v.trim() === '')) {
      throw new ConfigError(key + ' must be a non-empty string or null (got ' + JSON.stringify(v) + ')');
    }
  };
  // A ceiling is opt-in, so null is a first-class value here: it means "no
  // limit", which is different from an out-of-range number and must not be
  // coerced into one.
  const intOrNull = (key, min, max) => {
    const v = cfg[key];
    if (v === null || v === undefined) return;
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new ConfigError(key + ' must be an integer between ' + min + ' and ' + max + ', or null for no ceiling (got ' + JSON.stringify(v) + ')');
    }
  };
  const numOrNull = (key, min, max) => {
    const v = cfg[key];
    if (v === null || v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new ConfigError(key + ' must be a number between ' + min + ' and ' + max + ', or null for no ceiling (got ' + JSON.stringify(v) + ')');
    }
  };
  int('maxIterations', 1, 10);
  int('maxMinutes', 1, 120);
  intOrNull('maxTokens', 1000, 100 * 1000 * 1000);
  numOrNull('maxCostUsd', 0.01, 1000);
  int('ringBufferBytes', 4096, 64 * 1024 * 1024);
  int('keepReports', 0, 10000);
  strOrNull('testCommand');
  strOrNull('model');
  strOrNull('webhook');
  if (cfg.webhook !== null && !/^https?:\/\/\S+$/i.test(cfg.webhook)) {
    throw new ConfigError('webhook must be an http(s) URL (got ' + JSON.stringify(cfg.webhook) + ')');
  }
  if (typeof cfg.autoCommit !== 'boolean') throw new ConfigError('autoCommit must be true or false');
  if (typeof cfg.promptOnFinish !== 'boolean') throw new ConfigError('promptOnFinish must be true or false');
  if (typeof cfg.verifyCommand !== 'boolean') throw new ConfigError('verifyCommand must be true or false');
  if (typeof cfg.notify !== 'boolean') throw new ConfigError('notify must be true or false');
  if (typeof cfg.reportDir !== 'string' || !cfg.reportDir.trim()) throw new ConfigError('reportDir must be a non-empty string');
  // reportDir is interpolated into the guard hook's command line on Windows,
  // where arguments are quoted but not escaped -- so a `.phantomrc` carrying
  // `.phantom/reports" & calc & "` ran calc on every PreToolUse hook. It is
  // also joined into paths, so `..` segments would put phantom's own files
  // outside the repository it is allowed to touch. Neither is anything a real
  // report directory needs.
  if (/["'`$&|;<>^%!\r\n]/.test(cfg.reportDir)) {
    throw new ConfigError('reportDir must not contain shell metacharacters (got ' + JSON.stringify(cfg.reportDir) + ')');
  }
  if (path.isAbsolute(cfg.reportDir) || cfg.reportDir.split(/[/\\]/).includes('..')) {
    throw new ConfigError('reportDir must be a relative path inside the repository (got ' + JSON.stringify(cfg.reportDir) + ')');
  }
  if (typeof cfg.claudeBin !== 'string' || !cfg.claudeBin.trim()) throw new ConfigError('claudeBin must be a non-empty string');
  if (!Array.isArray(cfg.neverTouch) || cfg.neverTouch.some((g) => typeof g !== 'string')) {
    throw new ConfigError('neverTouch must be an array of glob strings');
  }
}

/**
 * Environment variables, one per config key that is useful to set per-run.
 *
 * The FAQ recommends running phantom in CI with `--dry-run`, but every setting
 * that mattered there -- the model, the caps, the test command, the webhook --
 * could only be changed by committing a `.phantomrc` into the repository. An
 * env var is how every other wrapper is configured and the only mechanism a
 * container or a CI job can use without writing a file.
 */
const ENV_KEYS = Object.freeze({
  PHANTOM_TEST: 'testCommand',
  PHANTOM_MAX_ITERATIONS: 'maxIterations',
  PHANTOM_MAX_MINUTES: 'maxMinutes',
  PHANTOM_MAX_TOKENS: 'maxTokens',
  PHANTOM_MAX_COST_USD: 'maxCostUsd',
  PHANTOM_MODEL: 'model',
  PHANTOM_WEBHOOK: 'webhook',
  PHANTOM_CLAUDE_BIN: 'claudeBin',
  PHANTOM_REPORT_DIR: 'reportDir',
  PHANTOM_KEEP_REPORTS: 'keepReports',
  PHANTOM_NOTIFY: 'notify',
  PHANTOM_AUTO_COMMIT: 'autoCommit',
  PHANTOM_PROMPT_ON_FINISH: 'promptOnFinish',
  PHANTOM_VERIFY_COMMAND: 'verifyCommand',
});

/** Config keys whose values are booleans, so an env string has to be coerced. */
const BOOLEAN_KEYS = new Set(['notify', 'autoCommit', 'promptOnFinish', 'verifyCommand']);
/** ...and the ones that are numbers. */
const NUMBER_KEYS = new Set(['maxIterations', 'maxMinutes', 'ringBufferBytes', 'keepReports', 'maxTokens']);
/** Accepts a decimal, unlike NUMBER_KEYS -- a cost ceiling of 0.50 is normal. */
const DECIMAL_KEYS = new Set(['maxCostUsd']);

/**
 * Read the env layer.
 *
 * Values are coerced, not trusted: an env var is always a string, and handing
 * `"3"` to a check that demands a number would fail late with a confusing
 * message. An unparseable boolean is an error rather than a silent `false` --
 * `PHANTOM_NOTIFY=maybe` meaning "off" is exactly the kind of quiet
 * misconfiguration that wastes an afternoon.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Partial<Config>}
 */
function envLayer(env = process.env) {
  const out = {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    if (BOOLEAN_KEYS.has(key)) {
      if (/^(1|true|yes|on)$/i.test(raw)) out[key] = true;
      else if (/^(0|false|no|off)$/i.test(raw)) out[key] = false;
      else throw new ConfigError(name + ' must be true or false (got ' + JSON.stringify(raw) + ')');
      continue;
    }
    if (DECIMAL_KEYS.has(key)) {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ConfigError(name + ' must be a number (got ' + JSON.stringify(raw) + ')');
      out[key] = n;
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      if (!/^\d+$/.test(raw)) throw new ConfigError(name + ' must be a whole number (got ' + JSON.stringify(raw) + ')');
      out[key] = Number(raw);
      continue;
    }
    // `null` is a meaningful value for testCommand/model/webhook -- it is how a
    // user turns an inherited setting back off for one run.
    out[key] = raw === 'null' ? null : raw;
  }
  return out;
}

/**
 * Precedence: overrides (flags) > env > .phantomrc (cwd, then git root)
 * > package.json "phantom" > defaults.
 *
 * Env sits between the flags and the files deliberately: a flag is this
 * invocation, an env var is this shell or this CI job, and a file is the
 * repository's own default. A file that could beat the environment would make
 * `PHANTOM_MODEL=... phantom npm test` silently do nothing in any repo that
 * happens to ship a `.phantomrc`.
 *
 * @param {string} [cwd]
 * @param {Partial<Config>} [overrides] undefined values are ignored
 * @param {{ env?: NodeJS.ProcessEnv, configPath?: string }} [opts]
 * @returns {Config}
 */
function loadConfig(cwd = process.cwd(), overrides = {}, opts = {}) {
  const gitRoot = git.root({ cwd });
  const dirs = [...new Set([path.resolve(cwd), gitRoot].filter(Boolean))];
  // An explicit --config wins over the search entirely, and a path that does
  // not exist is an error: silently falling back to the search would make a
  // typo look like "my settings had no effect".
  let rc;
  if (opts.configPath) {
    const file = path.resolve(cwd, opts.configPath);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      throw new ConfigError('config file not found: ' + opts.configPath);
    }
    try {
      rc = { file, data: JSON.parse(raw) };
    } catch (err) {
      // Deliberately NOT err.message: Node embeds the first bytes of the file in
      // its JSON parse error, so `--config ../secrets.env` echoed the start of
      // whatever it read back to the terminal. The position is enough to fix a
      // real config file.
      const at = /position (\d+)/.exec(err.message);
      throw new ConfigError('invalid JSON in ' + opts.configPath + (at ? ' at position ' + at[1] : ''));
    }
  } else {
    rc = findRc(dirs);
  }
  const pkg = findPkgField(dirs);
  const fromEnv = envLayer(opts.env || process.env);
  if (rc) assertObject(rc.data, '.phantomrc');
  if (pkg) assertObject(pkg.data, 'package.json "phantom" field');

  // Nearest file wins, whichever KIND it is. Ordering rc above pkg globally
  // meant a .phantomrc at the git root beat a package.json "phantom" field in
  // the directory you actually ran from -- the opposite of the "first hit
  // wins, nearest first" rule the help text and README both state. When the two
  // come from the same directory, .phantomrc stays the more specific of the two.
  const fileLayers = [pkg, rc].filter(Boolean).sort((a, b) => {
    const depth = (f) => path.dirname(f.file).split(path.sep).length;
    const d = depth(a) - depth(b);
    if (d !== 0) return d;                      // shallower first, so deeper overrides
    return a === rc ? 1 : -1;                   // same directory: .phantomrc wins
  }).map((f) => f.data);
  const layers = [DEFAULTS, ...fileLayers, fromEnv, overrides].filter(Boolean);
  for (const layer of layers.slice(1)) {
    for (const key of Object.keys(layer)) {
      if (!(key in DEFAULTS) && key !== 'alwaysNeverTouch') {
        throw new ConfigError('unknown config key "' + key + '" (known: ' + Object.keys(DEFAULTS).join(', ') + ')');
      }
    }
  }
  const cfg = {};
  for (const layer of layers) {
    for (const key of Object.keys(DEFAULTS)) {
      if (layer[key] !== undefined) cfg[key] = layer[key];
    }
  }
  validate(cfg);
  cfg.alwaysNeverTouch = [...ALWAYS_NEVER_TOUCH];
  cfg.neverTouch = [...new Set([...cfg.neverTouch, ...ALWAYS_NEVER_TOUCH])];
  Object.defineProperty(cfg, 'loadedFrom', {
    enumerable: false,
    value: [rc && rc.file, pkg && pkg.file, Object.keys(fromEnv).length ? 'environment' : null].filter(Boolean),
  });
  return cfg;
}

module.exports = {
  ENV_KEYS, envLayer, loadConfig, ConfigError, DEFAULTS, ALWAYS_NEVER_TOUCH };
