'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { send, which, DEFAULT_TIMEOUT_MS } = require('../src/desktop-notify');

/**
 * Fake child_process.spawn. Records every call; the returned child emits
 * `exit` (or `error`) on the next tick unless `never` is set.
 */
function fakeSpawn({ exitCode = 0, error = null, never = false, throws = null } = {}) {
  const calls = [];
  const spawn = (bin, args, options) => {
    if (throws) throw throws;
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ bin, args, options, child });
    if (!never) {
      process.nextTick(() => {
        if (error) child.emit('error', error);
        else child.emit('exit', exitCode, null);
      });
    }
    return child;
  };
  return { calls, spawn };
}

const whichOnly = (...names) => (bin) => (names.includes(bin) ? `/usr/local/bin/${bin}` : null);
const existingIcon = __filename; // existsSync only cares that the file exists

test('DEFAULT_TIMEOUT_MS is 4000', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 4000);
});

// ---------------------------------------------------------------- which

test('which finds a real binary via PATH and returns its absolute path', () => {
  const env = { PATH: path.dirname(process.execPath) };
  const found = which(path.basename(process.execPath), env);
  assert.equal(found, process.execPath);
  assert.ok(path.isAbsolute(found));
});

test('which finds sh on the real PATH', { skip: process.platform === 'win32' }, () => {
  const found = which('sh');
  assert.ok(found && path.isAbsolute(found) && found.endsWith('/sh'), String(found));
});

test('which returns null for a nonsense name, empty PATH, or bad input', () => {
  assert.equal(which('definitely-not-a-real-binary-xyz-123'), null);
  assert.equal(which('sh', { PATH: '' }), null);
  assert.equal(which('sh', {}), null);
  assert.equal(which(''), null);
  assert.equal(which(null), null);
});

// ---------------------------------------------------------------- darwin

test('darwin uses terminal-notifier with icon flags when the icon exists', async () => {
  const { calls, spawn } = fakeSpawn();
  const res = await send(
    { title: 'Phantom', message: 'crash fixed', subtitle: 'npm start', icon: existingIcon },
    { platform: 'darwin', spawn, which: whichOnly('terminal-notifier') },
  );
  assert.deepEqual(res, { ok: true, via: 'terminal-notifier' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/usr/local/bin/terminal-notifier');
  assert.deepEqual(calls[0].args, [
    '-title', 'Phantom',
    '-message', 'crash fixed',
    '-subtitle', 'npm start',
    '-appIcon', existingIcon,
    '-contentImage', existingIcon,
    '-group', 'claude-phantom',
  ]);
  assert.deepEqual(calls[0].options, { stdio: 'ignore', detached: false });
  assert.ok(!calls[0].args.includes('-sender'));
});

test('darwin terminal-notifier omits icon and subtitle flags when absent', async () => {
  const { calls, spawn } = fakeSpawn();
  await send({ title: 'T', message: 'M' }, { platform: 'darwin', spawn, which: whichOnly('terminal-notifier') });
  assert.deepEqual(calls[0].args, ['-title', 'T', '-message', 'M', '-group', 'claude-phantom']);
});

test('darwin terminal-notifier omits icon flags when the icon file does not exist', async () => {
  const { calls, spawn } = fakeSpawn();
  const res = await send(
    { title: 'T', message: 'M', icon: '/nonexistent/dir/phantom.png' },
    { platform: 'darwin', spawn, which: whichOnly('terminal-notifier') },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0].args, ['-title', 'T', '-message', 'M', '-group', 'claude-phantom']);
});

test('darwin falls back to osascript with properly escaped AppleScript literals', async () => {
  const { calls, spawn } = fakeSpawn();
  const res = await send(
    { title: 'Say "hi"', message: 'path C:\\tmp and "quoted"', icon: existingIcon },
    { platform: 'darwin', spawn, which: () => null },
  );
  assert.deepEqual(res, { ok: true, via: 'osascript' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'osascript');
  assert.deepEqual(calls[0].args, [
    '-e',
    'display notification "path C:\\\\tmp and \\"quoted\\"" with title "Say \\"hi\\""',
  ]);
});

test('darwin osascript includes subtitle when given and uses resolved path', async () => {
  const { calls, spawn } = fakeSpawn();
  await send(
    { title: 'T', message: 'M', subtitle: 'S' },
    { platform: 'darwin', spawn, which: whichOnly('osascript') },
  );
  assert.equal(calls[0].bin, '/usr/local/bin/osascript');
  assert.deepEqual(calls[0].args, ['-e', 'display notification "M" with title "T" subtitle "S"']);
});

// ---------------------------------------------------------------- linux

test('linux uses notify-send with icon', async () => {
  const { calls, spawn } = fakeSpawn();
  const res = await send(
    { title: 'Phantom', message: 'crash fixed', icon: existingIcon },
    { platform: 'linux', spawn, which: whichOnly('notify-send') },
  );
  assert.deepEqual(res, { ok: true, via: 'notify-send' });
  assert.equal(calls[0].bin, '/usr/local/bin/notify-send');
  assert.deepEqual(calls[0].args, ['-i', existingIcon, '-a', 'phantom', 'Phantom', 'crash fixed']);
});

test('linux notify-send without icon', async () => {
  const { calls, spawn } = fakeSpawn();
  await send({ title: 'T', message: 'M' }, { platform: 'linux', spawn, which: whichOnly('notify-send') });
  assert.deepEqual(calls[0].args, ['-a', 'phantom', 'T', 'M']);
});

test('linux skips when notify-send is not installed', async () => {
  const { calls, spawn } = fakeSpawn();
  const res = await send({ title: 'T', message: 'M' }, { platform: 'linux', spawn, which: () => null });
  assert.deepEqual(res, { ok: false, skipped: true });
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- other platforms

test('win32 and unknown platforms skip without spawning', async () => {
  for (const platform of ['win32', 'freebsd', 'sunos']) {
    const { calls, spawn } = fakeSpawn();
    const res = await send({ title: 'T', message: 'M' }, { platform, spawn, which: () => '/x' });
    assert.deepEqual(res, { ok: false, skipped: true }, platform);
    assert.equal(calls.length, 0, platform);
  }
});

// ---------------------------------------------------------------- failure modes

test('non-zero exit reports ok:false with via and error', async () => {
  const { spawn } = fakeSpawn({ exitCode: 2 });
  const res = await send({ title: 'T', message: 'M' }, { platform: 'linux', spawn, which: whichOnly('notify-send') });
  assert.deepEqual(res, { ok: false, via: 'notify-send', error: 'exit code 2' });
});

test('spawn error event reports ok:false without throwing', async () => {
  const { spawn } = fakeSpawn({ error: new Error('ENOENT') });
  const res = await send({ title: 'T', message: 'M' }, { platform: 'darwin', spawn, which: () => null });
  assert.deepEqual(res, { ok: false, via: 'osascript', error: 'ENOENT' });
});

test('synchronous spawn throw is swallowed', async () => {
  const { spawn } = fakeSpawn({ throws: new Error('EACCES') });
  const res = await send({ title: 'T', message: 'M' }, { platform: 'darwin', spawn, which: whichOnly('terminal-notifier') });
  assert.deepEqual(res, { ok: false, via: 'terminal-notifier', error: 'EACCES' });
});

test('timeout kills the child and resolves with error:timeout', async () => {
  const { calls, spawn } = fakeSpawn({ never: true });
  const started = Date.now();
  const res = await send(
    { title: 'T', message: 'M' },
    { platform: 'darwin', spawn, which: whichOnly('terminal-notifier'), timeoutMs: 25 },
  );
  assert.deepEqual(res, { ok: false, via: 'terminal-notifier', error: 'timeout' });
  assert.equal(calls[0].child.killed, true);
  assert.ok(Date.now() - started < 2000);
});

test('a late exit after timeout does not change the result or throw', async () => {
  const { calls, spawn } = fakeSpawn({ never: true });
  const res = await send({ title: 'T', message: 'M' }, { platform: 'linux', spawn, which: whichOnly('notify-send'), timeoutMs: 10 });
  assert.equal(res.error, 'timeout');
  calls[0].child.emit('exit', 0, null);
  calls[0].child.emit('error', new Error('late'));
});

test('null notification payload does not throw', async () => {
  const { calls, spawn } = fakeSpawn();
  const res = await send(null, { platform: 'linux', spawn, which: whichOnly('notify-send') });
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0].args, ['-a', 'phantom', 'claude-phantom', '']);
});

// ---------------------------------------------------------------- sanitising

test('strips ANSI escapes and collapses newlines in title, message and subtitle', async () => {
  const { calls, spawn } = fakeSpawn();
  await send(
    {
      title: '\x1b[1m\x1b[31mCrash\x1b[0m\r\ndetected',
      message: 'line one\nline two\n\n  line   three\t\x1b]8;;https://x\x07link\x1b]8;;\x07',
      subtitle: '\x1b[32mok\x1b[0m\nnow',
    },
    { platform: 'darwin', spawn, which: whichOnly('terminal-notifier') },
  );
  assert.deepEqual(calls[0].args, [
    '-title', 'Crash detected',
    '-message', 'line one line two line three link',
    '-subtitle', 'ok now',
    '-group', 'claude-phantom',
  ]);
});

test('caps message at 200 characters', async () => {
  const { calls, spawn } = fakeSpawn();
  await send({ title: 'T', message: 'x'.repeat(500) }, { platform: 'linux', spawn, which: whichOnly('notify-send') });
  const message = calls[0].args[calls[0].args.length - 1];
  assert.equal(message.length, 200);
  assert.ok(message.startsWith('x'.repeat(199)));
  assert.ok(message.endsWith('…'));
});

test('short messages are not truncated', async () => {
  const { calls, spawn } = fakeSpawn();
  await send({ title: 'T', message: 'y'.repeat(200) }, { platform: 'linux', spawn, which: whichOnly('notify-send') });
  assert.equal(calls[0].args[calls[0].args.length - 1], 'y'.repeat(200));
});
