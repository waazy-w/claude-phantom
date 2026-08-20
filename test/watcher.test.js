'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { runCommand, exitCodeFor, SpawnError } = require('../src/watcher');
const { extractStackTrace, detectCrash } = require('../src/crash');

const node = process.execPath;
const sink = () => new Writable({ write(c, e, cb) { cb(); } });
const collector = () => {
  const chunks = [];
  const s = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
  s.text = () => Buffer.concat(chunks).toString('utf8');
  s.bytes = () => chunks.reduce((n, c) => n + c.length, 0);
  s.raw = () => Buffer.concat(chunks);
  return s;
};
const run = (args, opts = {}) => runCommand(node, args, { stdout: sink(), stderr: sink(), ...opts });

test('clean exit preserves code 0 and code 7', async () => {
  const ok = await run(['-e', 'console.log("hi")']);
  assert.strictEqual(ok.exitCode, 0);
  assert.strictEqual(ok.signal, null);
  assert.strictEqual(ok.userInterrupted, false);
  assert.strictEqual(ok.tail, 'hi\n');
  assert.strictEqual(ok.command, node);
  assert.ok(ok.durationMs >= 0 && ok.endedAt >= ok.startedAt);
  assert.strictEqual(exitCodeFor(ok), 0);
  assert.strictEqual(detectCrash(ok), false);

  const seven = await run(['-e', 'process.exit(7)']);
  assert.strictEqual(seven.exitCode, 7);
  assert.strictEqual(exitCodeFor(seven), 7);
  assert.strictEqual(detectCrash(seven), true);
});

test('stdout and stderr are passed through byte-for-byte', async () => {
  const out = collector();
  const err = collector();
  const r = await run(['-e', 'process.stdout.write("a\\u00e9\\n"); process.stderr.write(Buffer.from([0xff, 0x0a])); process.stdout.write("b")'], { stdout: out, stderr: err });
  assert.strictEqual(out.text(), 'aé\nb');
  assert.deepStrictEqual([...err.raw()], [0xff, 0x0a]);
  assert.ok(r.tail.includes('aé'));
});

test('a child that throws: exit 1, stack extracted, hint file found', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-throw-'));
  const script = path.join(dir, 'boom.js');
  fs.writeFileSync(script, 'console.log("booting");\nfunction explode() { throw new TypeError("kaboom"); }\nexplode();\n');
  const r = await run([script], { cwd: dir });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(r.tail.includes('TypeError: kaboom'));
  const { errorLine, stackTrace, hintFiles } = extractStackTrace(r.tail, { cwd: dir });
  assert.strictEqual(errorLine, 'TypeError: kaboom');
  assert.ok(stackTrace.includes('at explode'));
  assert.deepStrictEqual(hintFiles, ['boom.js']);
});

test('child killed by SIGSEGV and SIGKILL', async () => {
  const seg = await run(['-e', 'process.kill(process.pid, "SIGSEGV"); setTimeout(() => {}, 5000)']);
  assert.strictEqual(seg.exitCode, null);
  assert.strictEqual(seg.signal, 'SIGSEGV');
  assert.strictEqual(exitCodeFor(seg), 128 + os.constants.signals.SIGSEGV);
  assert.strictEqual(detectCrash(seg), true);

  const p = run(['-e', 'setInterval(() => {}, 1000)']);
  assert.ok(p.child && p.child.pid > 0);
  setTimeout(() => p.kill('SIGKILL'), 100);
  const killed = await p;
  assert.strictEqual(killed.signal, 'SIGKILL');
  assert.strictEqual(killed.userInterrupted, false);
  assert.strictEqual(exitCodeFor(killed), 137);
});

test('flood: 20 MB of stdout arrives intact while the tail stays bounded', async () => {
  const out = collector();
  const total = 20 * 1024 * 1024;
  const r = await run(['-e', 'const b = Buffer.alloc(65536, 120); for (let i = 0; i < 320; i++) process.stdout.write(b);'], {
    stdout: out,
    ringBufferBytes: 256 * 1024,
  });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(out.bytes(), total);
  assert.strictEqual(Buffer.byteLength(r.tail), 256 * 1024);
});

test('missing command rejects with a SpawnError (ENOENT, exit 127)', async () => {
  await assert.rejects(runCommand('definitely-not-a-command-xyz', [], { stdout: sink(), stderr: sink() }), (err) => {
    assert.ok(err instanceof SpawnError);
    assert.strictEqual(err.code, 'ENOENT');
    assert.strictEqual(err.exitCode, 127);
    assert.strictEqual(err.message, 'command not found: definitely-not-a-command-xyz');
    return true;
  });
});

test('exitCodeFor falls back sanely', () => {
  assert.strictEqual(exitCodeFor({ exitCode: null, signal: 'SIGTERM' }), 143);
  assert.strictEqual(exitCodeFor({ exitCode: null, signal: 'SIGNOPE' }), 1);
  assert.strictEqual(exitCodeFor({ exitCode: null, signal: null }), 1);
});

function runWrapper(mode, env = {}) {
  const child = spawn(node, [path.join(__dirname, 'fixtures', 'wrapper.js'), mode], {
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    env: { ...process.env, ...env },
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const ready = new Promise((resolve) => child.on('message', (m) => m === 'ready' && resolve()));
  const done = new Promise((resolve) => child.on('exit', () => resolve(JSON.parse(out))));
  return { child, ready, done };
}

test('SIGINT to phantom is forwarded and marks userInterrupted', async () => {
  const w = runWrapper('idle');
  await w.ready;
  w.child.kill('SIGINT');
  const r = await w.done;
  assert.strictEqual(r.userInterrupted, true);
  assert.strictEqual(r.signal, 'SIGINT');
  assert.strictEqual(detectCrash(r), false);
});

test('a child that ignores SIGINT gets SIGKILL after the grace period', async () => {
  const w = runWrapper('ignoreSigint', { KILL_GRACE_MS: '300' });
  await w.ready;
  const t0 = Date.now();
  w.child.kill('SIGINT');
  const r = await w.done;
  assert.strictEqual(r.userInterrupted, true);
  assert.strictEqual(r.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 >= 250, 'killed too early');
});

test('SIGTERM to phantom is forwarded too', async () => {
  const w = runWrapper('idle');
  await w.ready;
  w.child.kill('SIGTERM');
  const r = await w.done;
  assert.strictEqual(r.userInterrupted, true);
  assert.strictEqual(r.signal, 'SIGTERM');
});

test('a colourised child stack still yields clean hint files (FORCE_COLOR)', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-color-'));
  const script = path.join(dir, 'boom.js');
  fs.writeFileSync(script, 'function explode() { throw new TypeError("kaboom"); }\nexplode();\n');
  const r = await run([script], { cwd: dir, env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: undefined } });
  assert.ok(r.tail.includes('\x1b['), 'the child really did emit escapes');
  const { errorLine, hintFiles } = extractStackTrace(r.tail, { cwd: dir });
  assert.strictEqual(errorLine, 'TypeError: kaboom');
  assert.deepStrictEqual(hintFiles, ['boom.js']);
});
