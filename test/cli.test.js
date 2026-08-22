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
/**
 * An environment that is explicitly NOT a nested Claude Code tool call.
 *
 * The suite is usually run FROM Claude Code, which exports CLAUDECODE=1, and a
 * test runner's stdin is never a TTY -- so phantom correctly reads the test
 * process as nested and captures instead of recovering. Tests that exercise the
 * recovery path have to say which side of that they are on, or the suite passes
 * or fails depending on the terminal it was started from.
 */
const notNested = (over = {}) => {
  const env = { ...process.env, ...over };
  delete env.CLAUDECODE;
  return env;
};

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
  const r = parseArgs(['--dry-run', '--allow-dirty', '--test=npm run check', '--max-minutes=9', '--model', 'm1', '--no-commit', '--no-prompt', '--', '--weird-cmd', '-x']);
  assert.strictEqual(r.command, '--weird-cmd');
  assert.deepStrictEqual(r.args, ['-x']);
  assert.deepStrictEqual(r.flags, {
    dryRun: true, allowDirty: true, nestedRecover: false, test: 'npm run check', maxIterations: null, maxMinutes: 9,
    model: 'm1', webhook: null, config: null, noCommit: true, noPrompt: true, notify: null,
    verifyCommand: null, verbose: false, version: false, help: false, list: false, force: false,
  });
  assert.deepStrictEqual(flagsToOverrides(r.flags), {
    testCommand: 'npm run check', maxIterations: undefined, maxMinutes: 9, model: 'm1',
    webhook: undefined, autoCommit: false, promptOnFinish: false, notify: undefined, verifyCommand: undefined,
  });
});

test('every boolean flag negates, so a config file can be overridden for one run', () => {
  // The table used to carry only the "on" half of each pair, and an override was
  // emitted only when a flag was truthy -- so once a .phantomrc set notify,
  // autoCommit or promptOnFinish to true there was no way to turn it off for a
  // single run without editing the file.
  const off = parseArgs(['--no-notify', '--commit', '--prompt', '--no-verify', 'npm', 'test']);
  assert.strictEqual(off.flags.notify, false);
  assert.strictEqual(off.flags.noCommit, false);
  assert.strictEqual(off.flags.noPrompt, false);
  assert.strictEqual(off.flags.verifyCommand, false);
  assert.deepStrictEqual(flagsToOverrides(off.flags), {
    testCommand: undefined, maxIterations: undefined, maxMinutes: undefined, model: undefined,
    webhook: undefined, autoCommit: true, promptOnFinish: true, notify: false, verifyCommand: false,
  });

  // Unmentioned stays undefined, so the layer below still wins. This is the
  // distinction the old two-state booleans could not make.
  const silent = parseArgs(['npm', 'test']);
  const o = flagsToOverrides(silent.flags);
  assert.strictEqual(o.notify, undefined);
  assert.strictEqual(o.autoCommit, undefined);
  assert.strictEqual(o.promptOnFinish, undefined);
  assert.strictEqual(o.verifyCommand, undefined);

  // And the "on" direction still works.
  const on = parseArgs(['--notify', '--verify', 'npm', 'test']);
  assert.strictEqual(flagsToOverrides(on.flags).notify, true);
  assert.strictEqual(flagsToOverrides(on.flags).verifyCommand, true);
});

test('--webhook and --config are parsed as value flags', () => {
  const r = parseArgs(['--webhook', 'https://example.com/hook', '--config', './ci.phantomrc', 'npm', 'test']);
  assert.strictEqual(r.flags.webhook, 'https://example.com/hook');
  assert.strictEqual(r.flags.config, './ci.phantomrc');
  assert.strictEqual(r.command, 'npm');
  assert.strictEqual(flagsToOverrides(r.flags).webhook, 'https://example.com/hook');
  assert.throws(() => parseArgs(['--webhook']), /requires a value/);
  assert.throws(() => parseArgs(['--config']), /requires a value/);
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
      cwd: dir, env: notNested(), stdout: capture(), stderr: capture(),
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
    // runRecovery prints the banner that states the outcome, and it is the last
    // thing the user reads; the CLI used to repeat the identical sentence
    // underneath it on every single run. Statuses that do get a banner are
    // therefore not echoed here.
    assert.ok(!text.includes('phantom › fixed: done'), 'the outcome is not printed twice');

    // A status with no banner behind it -- an early refusal -- still needs the
    // CLI to say something, or the run ends in silence.
    const refusedErr = capture();
    ui.setStream(refusedErr);
    await main([node, 'crash.js'], {
      cwd: dir, env: notNested(), stdout: capture(), stderr: capture(),
      recovery: { runRecovery: async () => ({ status: 'refused', message: 'nothing to go on' }) },
    });
    assert.ok(refusedErr.text().includes('refused: nothing to go on'), refusedErr.text());
    ui.setStream(phantomErr);

    const code2 = await main([node, 'crash.js'], {
      cwd: dir, env: notNested(), stdout: capture(), stderr: capture(),
      recovery: { runRecovery: async () => { throw new Error('recovery blew up'); } },
    });
    assert.strictEqual(code2, 1);
    assert.ok(phantomErr.text().includes('recovery failed: Error: recovery blew up'));
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('main: declines a crash with nothing to go on, but --dry-run still runs', async () => {
  // Observed for real on `phantom node -e "process.exit(7)"`: 90 seconds and
  // ~300k tokens to conclude nothing, because there was no error line, no stack
  // trace, no file named in the output and no test command -- so the session
  // could neither find the fault nor tell whether it had fixed it. That is the
  // shape of a linter or build tool exiting non-zero, which is common enough
  // that spending a session on it is a real cost for no possible benefit.
  const phantomErr = capture();
  ui.setStream(phantomErr);
  try {
    const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-cli-silent-'));
    fs.writeFileSync(path.join(repo, 'quiet.js'), 'process.exit(7)');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: repo });

    let called = false;
    const recovery = { runRecovery: async () => { called = true; return { status: 'fixed', message: 'x' }; } };

    assert.strictEqual(await main([node, 'quiet.js'], { cwd: repo, env: notNested(), stdout: capture(), stderr: capture(), recovery }), 7,
      'the exit code is still the command\'s');
    assert.ok(!called, 'no session is spent');
    assert.ok(phantomErr.text().includes('nothing to diagnose'), phantomErr.text());
    assert.ok(!phantomErr.text().includes('taking over'));

    // A diagnosis with no verification is precisely what dry run is for, so it
    // is still allowed to try.
    assert.strictEqual(await main(['--dry-run', node, 'quiet.js'], { cwd: repo, env: notNested(), stdout: capture(), stderr: capture(), recovery }), 7);
    assert.ok(called, 'dry run proceeds anyway');

    // And a project with a test command is not silent at all in the sense that
    // matters: the suite can both locate the fault and prove it is gone, so the
    // absence of a stack trace is no reason to decline.
    called = false;
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'q', version: '1.0.0', scripts: { test: 'node --test' } }));
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'add tests'], { cwd: repo });
    assert.strictEqual(await main([node, 'quiet.js'], { cwd: repo, env: notNested(), stdout: capture(), stderr: capture(), recovery }), 7);
    assert.ok(called, 'a testable project still gets a recovery');
  } finally { ui.setStream(null); }
});

test('main: refuses before the banner outside git or on a dirty tree, keeping the exit code', async () => {
  const phantomErr = capture();
  ui.setStream(phantomErr);
  try {
    const noGit = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-cli-nogit-'));
    fs.writeFileSync(path.join(noGit, 'crash.js'), 'process.exit(4)');
    let called = false;
    const recovery = { runRecovery: async () => { called = true; return { status: 'fixed', message: 'x' }; } };
    assert.strictEqual(await main([node, 'crash.js'], { cwd: noGit, env: notNested(), stdout: capture(), stderr: capture(), recovery }), 4);
    assert.ok(!called, 'recovery must not run outside git');
    assert.ok(phantomErr.text().includes('not a git repository'));
    assert.ok(!phantomErr.text().includes('taking over'));

    const dirty = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-cli-dirty-'));
    execFileSync('git', ['init', '-q'], { cwd: dirty });
    fs.writeFileSync(path.join(dirty, 'crash.js'), 'process.exit(5)');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: dirty });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: dirty });
    fs.writeFileSync(path.join(dirty, 'wip.txt'), 'uncommitted');
    assert.strictEqual(await main([node, 'crash.js'], { cwd: dirty, env: notNested(), stdout: capture(), stderr: capture(), recovery }), 5);
    assert.ok(!called, 'recovery must not run on a dirty tree');
    assert.ok(phantomErr.text().includes('--allow-dirty'));
    assert.strictEqual(await main(['--dry-run', node, 'crash.js'], { cwd: dirty, env: notNested(), stdout: capture(), stderr: capture(), recovery }), 5);
    assert.ok(called, 'dry run proceeds on a dirty tree');
  } finally {
    ui.setStream(null);
  }
});

test('bin/phantom.js is executable and runs end to end', () => {
  const bin = path.join(__dirname, '..', 'bin', 'phantom.js');
  // Windows has no POSIX mode bits (npm installs a .cmd shim instead), so only
  // assert the exec bit where it is what actually makes `phantom` runnable.
  if (process.platform !== 'win32') assert.ok(fs.statSync(bin).mode & 0o111, 'executable bit set');
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

test('a subcommand --help never starts work', async () => {
  // `phantom recover --help` used to reach runReplay and launch a real headless
  // session -- stashing, branching, patching, spending -- because the recover
  // branch parsed the flags and then never looked at them. Help must be
  // answered before anything is loaded or spawned.
  for (const name of ['doctor', 'ls', 'clean', 'recover']) {
    for (const flag of ['--help', '-h']) {
      const out = capture();
      let recoveryRan = false;
      const code = await main([name, flag], {
        cwd: process.cwd(), stdout: out, stderr: capture(),
        recovery: { runRecovery: async () => { recoveryRan = true; return { status: 'fixed', message: 'x' }; } },
      });
      assert.strictEqual(code, 0, name + ' ' + flag);
      assert.match(out.text(), /Usage: phantom /, name + ' ' + flag + ' printed help');
      assert.ok(!recoveryRan, name + ' ' + flag + ' must not start a recovery');
    }
  }
});

test('PHANTOM_DISABLED stops the subcommands too, not just the wrapper', async () => {
  // The documented kill switch says phantom becomes a pure passthrough. The
  // check lived inside replay.js behind a `config` the CLI always supplied, so
  // it was unreachable from the command line -- for the one subcommand that
  // spends money.
  for (const name of ['doctor', 'ls', 'clean', 'recover']) {
    let recoveryRan = false;
    const err = capture();
    ui.setStream(err);
    try {
      const code = await main([name], {
        cwd: process.cwd(), env: { ...process.env, PHANTOM_DISABLED: '1' },
        stdout: capture(), stderr: capture(),
        recovery: { runRecovery: async () => { recoveryRan = true; return { status: 'fixed', message: 'x' }; } },
      });
      assert.strictEqual(code, 0, name);
      assert.ok(!recoveryRan, name + ' must not run while disabled');
      assert.match(err.text(), /PHANTOM_DISABLED is set/, name);
    } finally { ui.setStream(null); }
  }
});

test('a subcommand placed after phantom\'s flags is named, not silently misrouted', async () => {
  // `phantom --verbose ls` ran /bin/ls with no warning; `phantom --dry-run
  // recover` died with "command not found: recover". Both look like phantom
  // commands and neither behaved like one.
  const err = capture();
  ui.setStream(err);
  try {
    const code = await main(['--verbose', 'ls'], { cwd: process.cwd(), stdout: capture(), stderr: capture() });
    assert.strictEqual(code, 2);
    assert.match(err.text(), /is a subcommand, so it goes first/);
    assert.match(err.text(), /phantom -- ls/, 'and points at the escape hatch');
  } finally { ui.setStream(null); }

  // The escape hatch itself still works: `--` first means wrap the real program.
  const out = capture();
  const code = await main(['--', 'node', '-e', 'process.stdout.write("real")'], {
    cwd: process.cwd(), stdout: out, stderr: capture(),
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(out.text(), 'real');
});

test('inside a Claude Code tool call, phantom captures instead of recovering', async () => {
  // A recovery cannot finish there. Claude Code's Bash tool times out at 120s
  // by default (600s maximum) and phantom's default maxMinutes is 15, so the
  // outer tool call is killed mid-recovery every time: the user sees a
  // truncated tool result and phantom takes its SIGTERM cleanup path. It is
  // also double spend -- an outer session paying for an inner headless one,
  // both against the same limit, while the outer sits blocked.
  //
  // This test also documents why every other test in this file passes
  // `notNested()`: the suite is usually run FROM Claude Code, so without it the
  // whole file exercises this branch by accident.
  const repo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-nested-'));
  fs.writeFileSync(path.join(repo, 'crash.js'), 'throw new TypeError("boom")');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: repo });

  const err = capture();
  ui.setStream(err);
  try {
    let called = false;
    const recovery = { runRecovery: async () => { called = true; return { status: 'fixed', message: 'x' }; } };
    const nested = { ...process.env, CLAUDECODE: '1' };

    const code = await main([node, 'crash.js'], { cwd: repo, env: nested, stdout: capture(), stderr: capture(), recovery });
    assert.strictEqual(code, 1, 'the exit code is still the command\'s');
    assert.ok(!called, 'no headless session is started inside a tool call');
    assert.match(err.text(), /captured it instead of recovering/);
    assert.match(err.text(), /\/phantom:recover/, 'and points at the command that can finish the job');

    // The capture is real, so the recovery can actually happen later.
    const crashes = fs.readdirSync(path.join(repo, '.phantom', 'crashes'));
    assert.strictEqual(crashes.length, 1, 'the crash was saved: ' + crashes.join(', '));

    // ...and the escape hatch still works for someone who means it.
    const code2 = await main(['--nested-recover', node, 'crash.js'], {
      cwd: repo, env: nested, stdout: capture(), stderr: capture(), recovery,
    });
    assert.strictEqual(code2, 1);
    assert.ok(called, '--nested-recover overrides the capture-only default');
  } finally { ui.setStream(null); }
});
