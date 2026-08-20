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
 * @property {string} reportDir
 * @property {number} ringBufferBytes
 * @property {string} claudeBin
 */

const ALWAYS_NEVER_TOUCH = Object.freeze(['.git/**', 'node_modules/**']);

const DEFAULTS = Object.freeze({
  testCommand: null,
  maxIterations: 3,
  maxMinutes: 15,
  neverTouch: Object.freeze(['.env', '.env.*', '**/*.pem', '**/*.key', '**/secrets/**', '**/*.secret*']),
  webhook: null,
  notify: false,
  model: null,
  autoCommit: true,
  reportDir: '.phantom/reports',
  ringBufferBytes: 262144,
  claudeBin: 'claude',
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
  int('maxIterations', 1, 10);
  int('maxMinutes', 1, 120);
  int('ringBufferBytes', 4096, 64 * 1024 * 1024);
  strOrNull('testCommand');
  strOrNull('model');
  strOrNull('webhook');
  if (cfg.webhook !== null && !/^https?:\/\/\S+$/i.test(cfg.webhook)) {
    throw new ConfigError('webhook must be an http(s) URL (got ' + JSON.stringify(cfg.webhook) + ')');
  }
  if (typeof cfg.autoCommit !== 'boolean') throw new ConfigError('autoCommit must be true or false');
  if (typeof cfg.notify !== 'boolean') throw new ConfigError('notify must be true or false');
  if (typeof cfg.reportDir !== 'string' || !cfg.reportDir.trim()) throw new ConfigError('reportDir must be a non-empty string');
  if (typeof cfg.claudeBin !== 'string' || !cfg.claudeBin.trim()) throw new ConfigError('claudeBin must be a non-empty string');
  if (!Array.isArray(cfg.neverTouch) || cfg.neverTouch.some((g) => typeof g !== 'string')) {
    throw new ConfigError('neverTouch must be an array of glob strings');
  }
}

/**
 * Precedence: overrides > .phantomrc (cwd, then git root) > package.json "phantom" > defaults.
 * @param {string} [cwd]
 * @param {Partial<Config>} [overrides] undefined values are ignored
 * @returns {Config}
 */
function loadConfig(cwd = process.cwd(), overrides = {}) {
  const gitRoot = git.root({ cwd });
  const dirs = [...new Set([path.resolve(cwd), gitRoot].filter(Boolean))];
  const rc = findRc(dirs);
  const pkg = findPkgField(dirs);
  if (rc) assertObject(rc.data, '.phantomrc');
  if (pkg) assertObject(pkg.data, 'package.json "phantom" field');

  const layers = [DEFAULTS, pkg && pkg.data, rc && rc.data, overrides].filter(Boolean);
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
    value: [rc && rc.file, pkg && pkg.file].filter(Boolean),
  });
  return cfg;
}

module.exports = { loadConfig, ConfigError, DEFAULTS, ALWAYS_NEVER_TOUCH };
