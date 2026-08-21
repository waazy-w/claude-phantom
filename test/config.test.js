'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig, ConfigError, DEFAULTS, ALWAYS_NEVER_TOUCH } = require('../src/config');

const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-cfg-'));
const write = (dir, name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));

test('defaults match the design doc', () => {
  const cfg = loadConfig(tmp());
  assert.deepStrictEqual(cfg, {
    testCommand: null,
    maxIterations: 3,
    maxMinutes: 15,
    neverTouch: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/secrets/**', '**/*.secret*', '.git/**', 'node_modules/**'],
    webhook: null,
    notify: false,
    model: null,
    autoCommit: true,
    promptOnFinish: true,
    verifyCommand: true,
    reportDir: '.phantom/reports',
    ringBufferBytes: 262144,
    claudeBin: 'claude',
    alwaysNeverTouch: ['.git/**', 'node_modules/**'],
  });
  assert.deepStrictEqual(cfg.loadedFrom, []);
  assert.deepStrictEqual([...ALWAYS_NEVER_TOUCH], ['.git/**', 'node_modules/**']);
  assert.strictEqual(DEFAULTS.maxIterations, 3);
});

test('precedence: overrides > .phantomrc > package.json > defaults', () => {
  const dir = tmp();
  write(dir, 'package.json', { name: 'x', phantom: { maxIterations: 5, maxMinutes: 20, model: 'pkg-model', reportDir: 'pkg-reports' } });
  write(dir, '.phantomrc', { maxIterations: 7, maxMinutes: 30 });
  const cfg = loadConfig(dir, { maxIterations: 9, testCommand: undefined });
  assert.strictEqual(cfg.maxIterations, 9);
  assert.strictEqual(cfg.maxMinutes, 30);
  assert.strictEqual(cfg.model, 'pkg-model');
  assert.strictEqual(cfg.reportDir, 'pkg-reports');
  assert.strictEqual(cfg.testCommand, null);
  assert.deepStrictEqual(cfg.loadedFrom, [path.join(dir, '.phantomrc'), path.join(dir, 'package.json')]);
});

test('.phantomrc is found at the git root when running from a subdirectory', () => {
  const dir = tmp();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  write(dir, '.phantomrc', { claudeBin: '/opt/claude' });
  const sub = path.join(dir, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  assert.strictEqual(loadConfig(sub).claudeBin, '/opt/claude');
  write(sub, '.phantomrc', { claudeBin: 'local-claude' });
  assert.strictEqual(loadConfig(sub).claudeBin, 'local-claude');
});

test('neverTouch merges with alwaysNeverTouch which cannot be removed', () => {
  const dir = tmp();
  write(dir, '.phantomrc', { neverTouch: ['secrets.json'], alwaysNeverTouch: [] });
  const cfg = loadConfig(dir);
  assert.deepStrictEqual(cfg.neverTouch, ['secrets.json', '.git/**', 'node_modules/**']);
  assert.deepStrictEqual(cfg.alwaysNeverTouch, ['.git/**', 'node_modules/**']);
  const cfg2 = loadConfig(dir, { neverTouch: ['.git/**'] });
  assert.deepStrictEqual(cfg2.neverTouch, ['.git/**', 'node_modules/**']);
});

test('validation errors are ConfigErrors with friendly messages', () => {
  const dir = tmp();
  const bad = (overrides, re) => assert.throws(() => loadConfig(dir, overrides), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ maxIterations: 0 }, /maxIterations must be an integer between 1 and 10/);
  bad({ maxIterations: 11 }, /maxIterations/);
  bad({ maxIterations: 2.5 }, /maxIterations/);
  bad({ maxMinutes: 121 }, /maxMinutes must be an integer between 1 and 120/);
  bad({ webhook: 'ftp://x' }, /webhook must be an http\(s\) URL/);
  bad({ webhook: 'nope' }, /webhook/);
  bad({ testCommand: '' }, /testCommand/);
  bad({ autoCommit: 'yes' }, /autoCommit/);
  bad({ neverTouch: 'x' }, /neverTouch/);
  bad({ bogus: 1 }, /unknown config key "bogus"/);
  assert.strictEqual(loadConfig(dir, { webhook: 'https://hooks.example.com/x' }).webhook, 'https://hooks.example.com/x');
});

test('malformed files and non-object config are rejected', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.phantomrc'), '{ not json');
  assert.throws(() => loadConfig(dir), /could not parse \.phantomrc/);
  fs.writeFileSync(path.join(dir, '.phantomrc'), '[1]');
  assert.throws(() => loadConfig(dir), /\.phantomrc must be a JSON object/);
  fs.unlinkSync(path.join(dir, '.phantomrc'));
  write(dir, 'package.json', { phantom: 'x' });
  assert.throws(() => loadConfig(dir), /"phantom" field must be a JSON object/);
});
