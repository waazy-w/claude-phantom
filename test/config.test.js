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
    maxTokens: null,
    maxCostUsd: null,
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
    keepReports: 50,
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

test('reportDir cannot carry shell metacharacters or escape the repository', () => {
  // reportDir is interpolated into the guard hook's command line on Windows,
  // where arguments are quoted but not escaped -- so a `.phantomrc` reading
  // `.phantom/reports" & calc & "` ran calc on every PreToolUse hook. It is
  // also joined into paths, so `..` would put phantom's own files outside the
  // repository it is allowed to touch. It was validated only as "a non-empty
  // string".
  for (const bad of [
    '.phantom/reports" & calc & "',
    ".phantom/reports' ; rm -rf / ; '",
    '.phantom/$(whoami)',
    '../../etc',
    '.phantom/../../..',
    '/tmp/absolute',
  ]) {
    assert.throws(() => loadConfig(tmp(), { reportDir: bad }), /reportDir must/, JSON.stringify(bad));
  }
  // Ordinary relative directories keep working, nested ones included.
  for (const good of ['.phantom/reports', 'reports', 'build/phantom/reports', '.phantom/reports/']) {
    assert.equal(loadConfig(tmp(), { reportDir: good }).reportDir, good);
  }
});

test('keepReports is validated like the other bounded integers', () => {
  assert.equal(loadConfig(tmp(), { keepReports: 5 }).keepReports, 5);
  assert.equal(loadConfig(tmp(), { keepReports: 0 }).keepReports, 0, '0 disables pruning');
  assert.throws(() => loadConfig(tmp(), { keepReports: -1 }), /keepReports/);
  assert.throws(() => loadConfig(tmp(), { keepReports: 99999 }), /keepReports/);
  assert.throws(() => loadConfig(tmp(), { keepReports: 'lots' }), /keepReports/);
});

test('environment variables sit between the flags and the config files', () => {
  // The FAQ recommends running phantom in CI with --dry-run, but every setting
  // that mattered there could only be changed by committing a .phantomrc into
  // the repository. Env is the layer a container or a CI job can actually use.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ model: 'from-file', maxMinutes: 5, notify: true }));

  const fromFile = loadConfig(dir, {}, { env: {} });
  assert.equal(fromFile.model, 'from-file');

  // Env beats the file: a repo that ships a .phantomrc must not silently make
  // `PHANTOM_MODEL=... phantom npm test` do nothing.
  const fromEnv = loadConfig(dir, {}, { env: { PHANTOM_MODEL: 'from-env', PHANTOM_MAX_MINUTES: '42' } });
  assert.equal(fromEnv.model, 'from-env');
  assert.equal(fromEnv.maxMinutes, 42);
  assert.equal(fromEnv.notify, true, 'and leaves untouched keys to the file');
  assert.ok(fromEnv.loadedFrom.includes('environment'));

  // Flags beat env, because a flag is this one invocation.
  assert.equal(loadConfig(dir, { model: 'from-flag' }, { env: { PHANTOM_MODEL: 'from-env' } }).model, 'from-flag');

  // Values are coerced and validated, not passed through as strings.
  assert.equal(typeof loadConfig(dir, {}, { env: { PHANTOM_MAX_ITERATIONS: '2' } }).maxIterations, 'number');
  for (const [name, value] of [['PHANTOM_NOTIFY', 'yes'], ['PHANTOM_AUTO_COMMIT', 'off'], ['PHANTOM_VERIFY_COMMAND', '0']]) {
    assert.equal(typeof loadConfig(dir, {}, { env: { [name]: value } })[require('../src/config').ENV_KEYS[name]], 'boolean');
  }
  // An unparseable boolean is an error, not a silent false -- PHANTOM_NOTIFY=maybe
  // quietly meaning "off" is exactly the misconfiguration that wastes an afternoon.
  assert.throws(() => loadConfig(dir, {}, { env: { PHANTOM_NOTIFY: 'maybe' } }), /must be true or false/);
  assert.throws(() => loadConfig(dir, {}, { env: { PHANTOM_MAX_MINUTES: 'soon' } }), /whole number/);
  // Bounds still apply to a value that arrived through the environment.
  assert.throws(() => loadConfig(dir, {}, { env: { PHANTOM_MAX_ITERATIONS: '99' } }), /maxIterations/);
  // An empty var is "not set", so an exported-but-blank variable is harmless.
  assert.equal(loadConfig(dir, {}, { env: { PHANTOM_MODEL: '' } }).model, 'from-file');
  // "null" turns an inherited setting back off for one run.
  assert.equal(loadConfig(dir, {}, { env: { PHANTOM_MODEL: 'null' } }).model, null);
});

test('--config uses the named file and fails loudly when it is missing', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ model: 'default-file' }));
  fs.writeFileSync(path.join(dir, 'ci.json'), JSON.stringify({ model: 'ci-file', maxMinutes: 3 }));

  const cfg = loadConfig(dir, {}, { configPath: 'ci.json' });
  assert.equal(cfg.model, 'ci-file', 'the named file wins over the searched one');
  assert.equal(cfg.maxMinutes, 3);

  // A typo must not silently fall back to the search: that turns "my settings
  // had no effect" into a mystery instead of an error.
  assert.throws(() => loadConfig(dir, {}, { configPath: 'nope.json' }), /config file not found/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
  assert.throws(() => loadConfig(dir, {}, { configPath: 'bad.json' }), /invalid JSON/);
});

test('a --config parse error never echoes the file it read', () => {
  // Node embeds the first bytes of the input in its JSON parse error, so
  // `--config ../secrets.env` printed the start of whatever it read back to
  // the terminal. The position is enough to fix a real config file.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'SUPER_SECRET_TOKEN=sk-ant-abcdef123456\n');
  try {
    loadConfig(dir, {}, { configPath: 'secret.txt' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /invalid JSON in secret\.txt/);
    assert.ok(!/SUPER_SECRET|sk-ant/.test(err.message), 'leaked content: ' + err.message);
  }
});

test('the nearest config file wins, whichever kind it is', () => {
  // The layer order was [defaults, pkg, rc, env, flags] unconditionally, so a
  // .phantomrc at the git ROOT beat a package.json "phantom" field in the
  // directory you actually ran from -- the opposite of the "nearest first,
  // first hit wins" rule both the help text and the README state.
  const root = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, '.phantomrc'), JSON.stringify({ model: 'rc-at-root' }));
  fs.writeFileSync(path.join(root, 'sub', 'package.json'), JSON.stringify({ phantom: { model: 'pkg-in-sub' } }));

  assert.equal(loadConfig(path.join(root, 'sub')).model, 'pkg-in-sub', 'the nearer file wins');
  assert.equal(loadConfig(root).model, 'rc-at-root');

  // Same directory: .phantomrc is the more specific of the two and still wins.
  const flat = tmp();
  fs.writeFileSync(path.join(flat, '.phantomrc'), JSON.stringify({ model: 'from-rc' }));
  fs.writeFileSync(path.join(flat, 'package.json'), JSON.stringify({ phantom: { model: 'from-pkg' } }));
  assert.equal(loadConfig(flat).model, 'from-rc');
});
