'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { parseArgs, helpText, main, UsageError, flagsToOverrides } = require('../src/cli');
const ui = require('../src/ui');

const node = process.execPath;
const capture = () => {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  s.text = () => text;
  return s;
};

test('parseArgs: flags before the command, passthrough after it', () => {
  const r = parseArgs(['--verbose', '--max-iterations', '5', 'npm', 'run', 'dev', '--verbose', '--help']);
  assert.strictEqual(r.command, 'npm');
  assert.deepStrictEqual(r.args, ['run', 'dev', '--verbose', '--help']);
  assert.strictEqual(r.flags.verbose, true);
  assert.strictEqual(r.flags.maxIterations, 5);
  assert.strictEqual(r.flags.help, false);
});

test('parseArgs: -- separator, = values, all flags', () => {
  const r = parseArgs(['--dry-run', '--allow-dirty', '--test=npm run check', '--max-minutes=9', '--model', 'm1', '--no-commit', '--', '--weird-cmd', '-x']);
  assert.strictEqual(r.command, '--weird-cmd');
  assert.deepStrictEqual(r.args, ['-x']);
  assert.deepStrictEqual(r.flags, {
    dryRun: true, allowDirty: true, test: 'npm run check', maxIterations: null, maxMinutes: 9,
    model: 'm1', noCommit: true, notify: false, verbose: false, version: false, help: false,
  });
  assert.deepStrictEqual(flagsToOverrides(r.flags), { testCommand: 'npm run check', maxIterations: undefined, maxMinutes: 9, model: 'm1', autoCommit: false, notify: undefined });
});

test('parseArgs: edge cases', () => {
  const empty = parseArgs([]);
  assert.strictEqual(empty.command, null);
  assert.deepStrictEqual(empty.args, []);
  assert.strictEqual(parseArgs(['--help']).flags.help, true);
  assert.strictEqual(parseArgs(['-h']).flags.help, true);
  assert.strictEqual(parseArgs(['--version']).flags.version, true);
  assert.strictEqual(parseArgs(['--']).command, null);
  assert.strictEqual(parseArgs(['-', 'a']).command, '-');
  assert.throws(() => parseArgs(['--bogus', 'npm']), UsageError);
  assert.throws(() => parseArgs(['--max-iterations', 'three', 'npm']), /whole number/);
  assert.throws(() => parseArgs(['--max-iterations', '-1', 'npm']), /whole number/);
  assert.throws(() => parseArgs(['--model']), /requires a value/);
  assert.throws(() => parseArgs(['--verbose=1', 'npm']), /does not take a value/);
  assert.ok(helpText().includes('--dry-run'));
  assert.ok(helpText().includes('phantom npm run dev --verbose'));
});

test('main: --help/--version go to the given stdout, usage errors return 2', async () => {
  const out = capture();
  const err = capture();
  ui.setStream(err);
  try {
    assert.strictEqual(await main(['--help'], { stdout: out }), 0);
    assert.ok(out.text().startsWith('Usage: phantom'));
    assert.strictEqual(await main(['--version'], { stdout: out }), 0);
    assert.match(out.text(), /\n\d+\.\d+\.\d+\n$/);
    assert.strictEqual(await main(['--nope', 'x'], { stdout: out }), 2);
    assert.ok(err.text().includes('unknown option --nope'));
    assert.strictEqual(await main(['--max-iterations', '99', 'true'], { stdout: out }), 2);
    assert.ok(err.text().includes('config error: maxIterations'));
  } finally {
    ui.setStream(null);
  }
});

test('main: clean exit returns the child code silently; missing command gives 127', async () => {
  const phantomErr = capture();
  const out = capture();
  ui.setStream(phantomErr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-cli-'));
  try {
    assert.strictEqual(await main([node, '-e', 'console.log("ok")'], { cwd: dir, stdout: out, stderr: capture() }), 0);
    assert.strictEqual(out.text(), 'ok\n');
    assert.strictEqual(phantomErr.text(), '');
    assert.strictEqual(await main(['no-such-binary-zz'], { cwd: dir, stdout: out, stderr: capture() }), 127);
    assert.ok(phantomErr.text().includes('command not found: no-such-binary-zz'));
  } finally {
    ui.setStream(null);
  }
});

test('main: PHANTOM_DISABLED is pure passthrough even on crash', async () => {
  const phantomErr = capture();
  ui.setStream(phantomErr);
  try {
    let called = false;
    const code = await main([node, '-e', 'process.exit(3)'], {
      env: { ...process.env, PHANTOM_DISABLED: '1' },
      stdout: capture(), stderr: capture(),
      recovery: { runRecovery: async () => { called = true; } },
    });
    assert.strictEqual(code, 3);
    assert.strictEqual(called, false);
    assert.strictEqual(phantomErr.text(), '');
  } finally {
    ui.setStream(null);
  }
});

test('main: crash prints the banner, hands off to recovery, and keeps the child exit code', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-cli-crash-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'crash.js'), 'throw new RangeError("out of cheese")');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: dir });
  const phantomErr = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(phantomErr);
  try {
    let seen = null;
    const code = await main(['--dry-run', '--test', 'npm run check', node, 'crash.js'], {
      cwd: dir, stdout: capture(), stderr: capture(),
      recovery: { runRecovery: async (ctx, config, flags) => { seen = { ctx, config, flags }; return { status: 'fixed', message: 'done', branch: 'phantom/x', reportPath: null, iterations: 1, testsPassed: true }; } },
    });
    assert.strictEqual(code, 1, 'a fixed crash still exits with the original code');
    assert.ok(seen, 'recovery was called');
    assert.strictEqual(seen.ctx.errorLine, 'RangeError: out of cheese');
    assert.deepStrictEqual(seen.ctx.hintFiles, ['crash.js']);
    assert.strictEqual(seen.config.testCommand, 'npm run check');
    assert.strictEqual(seen.flags.dryRun, true);
    const text = phantomErr.text();
    const unwrapped = text.replace(/\s*│\s*/g, ' ').replace(/ +/g, ' ');
    assert.ok(unwrapped.includes('⚠ ' + node + ' crash.js crashed (exit code 1) — phantom is taking over'), text);
    assert.ok(text.includes('RangeError: out of cheese'));
    const evs = require('../src/events').readEvents(dir);
    assert.strictEqual(evs.length, 1, 'crash event logged');
    assert.strictEqual(evs[0].type, 'crash');
    assert.strictEqual(evs[0].error, 'RangeError: out of cheese');
    assert.ok(text.includes('╭') && text.includes('╰'));
    assert.ok(text.includes('phantom › fixed: done'));

    const code2 = await main([node, 'crash.js'], {
      cwd: dir, stdout: capture(), stderr: capture(),
      recovery: { runRecovery: async () => { throw new Error('recovery blew up'); } },
    });
    assert.strictEqual(code2, 1);
    assert.ok(phantomErr.text().includes('recovery failed: Error: recovery blew up'));
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('main: refuses before the banner outside git or on a dirty tree, keeping the exit code', async () => {
  const phantomErr = capture();
  ui.setStream(phantomErr);
  try {
    const noGit = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-cli-nogit-'));
    fs.writeFileSync(path.join(noGit, 'crash.js'), 'process.exit(4)');
    let called = false;
    const recovery = { runRecovery: async () => { called = true; return { status: 'fixed', message: 'x' }; } };
    assert.strictEqual(await main([node, 'crash.js'], { cwd: noGit, stdout: capture(), stderr: capture(), recovery }), 4);
    assert.ok(!called, 'recovery must not run outside git');
    assert.ok(phantomErr.text().includes('not a git repository'));
    assert.ok(!phantomErr.text().includes('taking over'));

    const dirty = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-cli-dirty-'));
    execFileSync('git', ['init', '-q'], { cwd: dirty });
    fs.writeFileSync(path.join(dirty, 'crash.js'), 'process.exit(5)');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: dirty });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: dirty });
    fs.writeFileSync(path.join(dirty, 'wip.txt'), 'uncommitted');
    assert.strictEqual(await main([node, 'crash.js'], { cwd: dirty, stdout: capture(), stderr: capture(), recovery }), 5);
    assert.ok(!called, 'recovery must not run on a dirty tree');
    assert.ok(phantomErr.text().includes('--allow-dirty'));
    assert.strictEqual(await main(['--dry-run', node, 'crash.js'], { cwd: dirty, stdout: capture(), stderr: capture(), recovery }), 5);
    assert.ok(called, 'dry run proceeds on a dirty tree');
  } finally {
    ui.setStream(null);
  }
});

test('bin/phantom.js is executable and runs end to end', () => {
  const bin = path.join(__dirname, '..', 'bin', 'phantom.js');
  assert.ok(fs.statSync(bin).mode & 0o111, 'executable bit set');
  assert.strictEqual(fs.readFileSync(bin, 'utf8').split('\n')[0], '#!/usr/bin/env node');
  const out = execFileSync(node, [bin, node, '-e', 'console.log("through")'], { encoding: 'utf8' });
  assert.strictEqual(out, 'through\n');
  let status = null;
  try {
    execFileSync(node, [bin, node, '-e', 'process.exit(5)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHANTOM_DISABLED: '1' } });
  } catch (e) {
    status = e.status;
  }
  assert.strictEqual(status, 5);
});
