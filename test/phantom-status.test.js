'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const events = require('../src/events');

const BIN = path.join(__dirname, '..', 'bin', 'phantom-status.js');
const ctx = { command: 'npm', args: ['run', 'dev'], errorLine: 'TypeError: boom', exitCode: 1, signal: null };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-status-'));
}

function run({ input, rawStdin, cwd, args = [], color = false } = {}) {
  const env = { ...process.env };
  if (color) delete env.NO_COLOR; else env.NO_COLOR = '1';
  const stdin = rawStdin !== undefined ? rawStdin : input === undefined ? undefined : JSON.stringify(input);
  const r = spawnSync(process.execPath, [BIN, ...args], { input: stdin, cwd: cwd || tmp(), env, encoding: 'utf8' });
  assert.equal(r.status, 0, 'exit code is always 0: ' + r.stderr);
  assert.equal(r.stderr, '', 'never writes stderr');
  return r.stdout;
}

const line = (opts) => run(opts).replace(/\n$/, '');
const statusInput = (dir) => ({ cwd: dir, workspace: { current_dir: dir, project_dir: dir }, session_id: 'test' });

function recovery(root, status, branch = null, now = Date.now(), command = ctx) {
  const final = { status, branch, reportPath: null, message: '' };
  return events.appendEvent(root, events.recoveryEvent(command, final, root), { now });
}

test('is executable and has a node shebang', () => {
  // X_OK is meaningless on Windows -- it always succeeds -- but the exec bit is
  // exactly what makes the shipped bin runnable on POSIX, so keep it asserted there.
  if (process.platform !== 'win32') fs.accessSync(BIN, fs.constants.X_OK);
  // Asserted on every platform: a CRLF checkout would ship `#!/usr/bin/env node\r`,
  // which POSIX kernels refuse to exec. .gitattributes pins these files to LF.
  assert.ok(fs.readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n'));
});

test('nothing unread: prints nothing', () => {
  const root = tmp();
  assert.equal(run({ input: statusInput(root) }), '');
  events.appendEvent(root, events.crashEvent(ctx));
  events.markRead(root);
  assert.equal(run({ input: statusInput(root) }), '');
});

test('recent crash with no recovery: fixing…', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx), { now: Date.now() - 3 * 60000 });
  assert.equal(line({ input: statusInput(root) }), '👻 fixing npm run dev…');
});

test('crash older than 20 minutes with no recovery: crashed Nm ago', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx), { now: Date.now() - 25 * 60000 });
  assert.equal(line({ input: statusInput(root) }), '👻 npm run dev crashed 25m ago');
});

test('recovery states: fixed / unfixed / dry-run / other', () => {
  const fixed = tmp();
  recovery(fixed, 'fixed', 'phantom/fix-20260820-1432-customer');
  assert.equal(line({ input: statusInput(fixed) }), '👻 fixed npm run dev → phantom/fix-20260820-1432-customer');

  const fixedNoBranch = tmp();
  recovery(fixedNoBranch, 'fixed');
  assert.equal(line({ input: statusInput(fixedNoBranch) }), '👻 fixed npm run dev');

  const unfixed = tmp();
  recovery(unfixed, 'unfixed');
  assert.equal(line({ input: statusInput(unfixed) }), '👻 could not fix npm run dev');

  const dry = tmp();
  recovery(dry, 'dry-run');
  assert.equal(line({ input: statusInput(dry) }), '👻 dry run: npm run dev');

  const other = tmp();
  recovery(other, 'timeout');
  assert.equal(line({ input: statusInput(other) }), '👻 timeout: npm run dev');
});

test('the most recent unread event wins and extra unread events are counted', () => {
  const root = tmp();
  const now = Date.now();
  events.appendEvent(root, events.crashEvent(ctx), { now: now - 3 * 60000 });
  recovery(root, 'fixed', 'phantom/fix-x', now - 60000);
  assert.equal(line({ input: statusInput(root) }), '👻 fixed npm run dev → phantom/fix-x (+1)');

  events.appendEvent(root, events.crashEvent(ctx), { now });
  assert.equal(line({ input: statusInput(root) }), '👻 fixing npm run dev… (+2)');
});

test('stale events are not shown', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx), { now: Date.now() - 30 * 3600000 });
  assert.equal(run({ input: statusInput(root) }), '');
});

test('long commands are truncated to 40 characters with an ellipsis', () => {
  const root = tmp();
  const long = { command: 'node', args: ['--experimental-strip-types', 'scripts/very/long/path/to/some/server-entry.ts', '--port', '3000'] };
  events.appendEvent(root, events.crashEvent(long), { now: Date.now() - 60000 });
  const out = line({ input: statusInput(root) });
  const cmd = out.slice('👻 fixing '.length, -1);
  assert.equal(cmd.length, 40);
  assert.ok(cmd.endsWith('…'), cmd);
  assert.equal(cmd, 'node --experimental-strip-types scripts…');
});

test('colours: green ghost, state colour for the text, none under NO_COLOR', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx), { now: Date.now() - 60000 });
  const coloured = line({ input: statusInput(root), color: true });
  assert.equal(coloured, '\x1b[32m👻\x1b[0m \x1b[33mfixing npm run dev…\x1b[0m');
  assert.ok(!line({ input: statusInput(root) }).includes('\x1b['));

  const fixed = tmp();
  recovery(fixed, 'fixed', 'phantom/fix-x');
  assert.equal(line({ input: statusInput(fixed), color: true }), '\x1b[32m👻\x1b[0m \x1b[32mfixed npm run dev → phantom/fix-x\x1b[0m');

  const old = tmp();
  events.appendEvent(old, events.crashEvent(ctx), { now: Date.now() - 40 * 60000 });
  assert.ok(line({ input: statusInput(old), color: true }).includes('\x1b[31mnpm run dev crashed 40m ago\x1b[0m'));

  const dry = tmp();
  recovery(dry, 'dry-run');
  assert.ok(line({ input: statusInput(dry), color: true }).includes('\x1b[36mdry run: npm run dev\x1b[0m'));
});

test('--mark-read acknowledges everything and prints nothing', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx));
  assert.equal(run({ input: statusInput(root), args: ['--mark-read'] }), '');
  assert.equal(run({ input: statusInput(root) }), '');
  assert.deepEqual(events.readUnread(root), []);
  assert.equal(run({ input: statusInput(tmp()), args: ['--mark-read'] }), '', 'no repo: still silent');
});

test('--help prints usage to stdout', () => {
  const out = run({ args: ['--help'] });
  assert.match(out, /phantom-status/);
  assert.match(out, /--mark-read/);
});

test('workspace.current_dir is preferred, then cwd, then process.cwd()', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx), { now: Date.now() - 60000 });
  assert.equal(line({ input: { cwd: tmp(), workspace: { current_dir: root } } }), '👻 fixing npm run dev…');
  assert.equal(line({ input: { cwd: root } }), '👻 fixing npm run dev…');
  assert.equal(line({ input: {}, cwd: root }), '👻 fixing npm run dev…');
  assert.equal(line({ input: { cwd: path.join(root, 'a', 'b') } }), '👻 fixing npm run dev…', 'nested cwd that does not exist yet still walks up');
});

test('missing or invalid stdin is handled', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx), { now: Date.now() - 60000 });
  assert.equal(line({ rawStdin: 'not json', cwd: root }), '👻 fixing npm run dev…');
  assert.equal(line({ rawStdin: '', cwd: root }), '👻 fixing npm run dev…');
  assert.equal(run({ cwd: tmp() }), '');
  assert.equal(run({ rawStdin: '{"workspace":{"current_dir":42}}', cwd: tmp() }), '');
});

test('no executable calls process.exit() after writing to stdout', () => {
  // Writes to a pipe complete asynchronously on Windows, and past the ~64 KiB
  // buffer everywhere; process.exit() discards whatever libuv still has queued,
  // silently. plugin/hooks/phantom-events.js shipped that bug and lost crash
  // briefings to it. The rule that actually prevents a recurrence is structural
  // -- set process.exitCode and let the process end once the bytes are out --
  // because the truncation itself is unreachable from realistic input here
  // (shortCmd caps a status line at CMD_MAX) and so cannot be tested directly.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = [
    'bin/phantom-status.js',
    'bin/phantom.js',
    'src/guard-hook.js',
    'plugin/hooks/phantom-events.js',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const writes = /process\.(stdout|stderr)\.write\(/.test(src);
    if (!writes) continue;
    const offenders = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(?:^|[^.\w])process\.exit\(/.test(line) && !line.startsWith('//') && !line.startsWith('*'));
    assert.deepStrictEqual(offenders, [],
      rel + ' writes to stdout/stderr, so it must set process.exitCode rather than call process.exit()');
  }
});
