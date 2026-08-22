'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { runCommand, exitCodeFor, SpawnError, FORWARDED_SIGNALS, killTreeByPid, windowsSafeSpawn, escapeArgForCmd } = require('../src/watcher');
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
// Windows has no POSIX signals: kill() is TerminateProcess, so a signal is never
// delivered to a handler and an exited child only ever reports an exit code.
const noSignals = process.platform === 'win32'
  ? 'signals are not deliverable on Windows: kill() terminates outright and children report no signal'
  : false;

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

test('child killed by SIGSEGV and SIGKILL', { skip: noSignals }, async () => {
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

test('SIGINT to phantom is forwarded and marks userInterrupted', { skip: noSignals }, async () => {
  const w = runWrapper('idle');
  await w.ready;
  w.child.kill('SIGINT');
  const r = await w.done;
  assert.strictEqual(r.userInterrupted, true);
  assert.strictEqual(r.signal, 'SIGINT');
  assert.strictEqual(detectCrash(r), false);
});

test('a child that ignores SIGINT gets SIGKILL after the grace period', { skip: noSignals }, async () => {
  const w = runWrapper('ignoreSigint', { KILL_GRACE_MS: '300' });
  await w.ready;
  const t0 = Date.now();
  w.child.kill('SIGINT');
  const r = await w.done;
  assert.strictEqual(r.userInterrupted, true);
  assert.strictEqual(r.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 >= 250, 'killed too early');
});

test('SIGTERM to phantom is forwarded too', { skip: noSignals }, async () => {
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

test('a spawn that is refused synchronously still arrives as a SpawnError', async () => {
  // ENOENT is delivered asynchronously, on the child's 'error' event (the test
  // above). spawn() also refuses some calls outright, before any child exists --
  // a NUL byte anywhere in the argv or the environment is the reachable one --
  // and that throw happens inside the promise executor. If it escapes as the
  // raw TypeError, cli.js rethrows it (`if (!(err instanceof SpawnError))`) and
  // the user gets a stack trace and exit 1 instead of one line and exit 126.
  const NUL = String.fromCharCode(0);
  for (const [why, opts, args] of [
    ['argument', {}, ['-e', 'a' + NUL + 'b']],
    ['environment value', { env: { ...process.env, PHANTOM_X: 'a' + NUL + 'b' } }, ['-e', '1']],
  ]) {
    const p = runCommand(node, args, { stdout: sink(), stderr: sink(), ...opts });
    // No child was ever created, so the kill switch must be a safe no-op rather
    // than the thing that throws while the caller is handling the failure.
    assert.strictEqual(p.child, null, why);
    assert.strictEqual(p.kill(), false, why);
    await assert.rejects(p, (err) => {
      assert.ok(err instanceof SpawnError, why + ': got ' + err.name);
      assert.strictEqual(err.command, node);
      assert.strictEqual(err.code, 'ERR_INVALID_ARG_VALUE');
      // 126, not 127: the command exists, it could not be started.
      assert.strictEqual(err.exitCode, 126);
      assert.ok(err.message.startsWith('failed to start ' + node + ': '), err.message);
      assert.match(err.message, /null bytes/);
      return true;
    });
  }
});

test('a failed start leaves no signal handlers behind', async () => {
  // The handlers are installed per run and removed by the 'close'/'error'
  // cleanup. A run that never produces a child must not add them, and a run
  // that fails after the child exists must take them back off -- otherwise
  // every crashed command in a long phantom session leaks three listeners and
  // Node starts warning about a leak that is really phantom's.
  const before = FORWARDED_SIGNALS.map((s) => process.listenerCount(s));
  await assert.rejects(runCommand(node, ['-e', 'a' + String.fromCharCode(0)], { stdout: sink(), stderr: sink() }));
  await assert.rejects(runCommand('definitely-not-a-command-xyz', [], { stdout: sink(), stderr: sink() }));
  await run(['-e', 'process.exit(3)']);
  assert.deepStrictEqual(FORWARDED_SIGNALS.map((s) => process.listenerCount(s)), before);
});

test('windowsSafeSpawn decides on the platform first, then on what the name resolves to', () => {
  // The three routes out of this function are chosen before anything is
  // spawned, and choosing wrong is silent: a shim spawned directly fails with
  // ENOENT on Windows, and a real .exe sent through cmd.exe gets its argv
  // re-parsed (the bug the whole branch exists for). Off win32 the cmd.exe
  // branch is unreachable, and the Windows CI job never spawns a batch shim, so
  // the decision is exercised here with the platform stubbed. windows-spawn.js
  // owns the identity return and the escaping of the line; this owns the fork.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'phantom-dispatch-'));
  fs.writeFileSync(path.join(dir, 'npm.cmd'), '');
  fs.writeFileSync(path.join(dir, 'tool.exe'), '');
  const env = { PATHEXT: '.exe;.cmd', Path: dir, ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const args = ['run', 'dev x'];

  // Off win32 every one of these is the identity, whatever the name resolves to.
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    assert.deepStrictEqual(windowsSafeSpawn('npm', args, dir, env), { file: 'npm', argv: args, opts: {} });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    // A resolved .cmd shim is the only case that gets cmd.exe.
    const shim = windowsSafeSpawn('npm', args, dir, env);
    assert.strictEqual(shim.file, env.ComSpec);
    assert.deepStrictEqual(shim.argv.slice(0, 3), ['/d', '/s', '/c']);
    assert.strictEqual(shim.argv.length, 4, 'the whole line is one argv slot');
    // Without this cmd.exe would re-quote the line phantom just escaped by hand.
    assert.strictEqual(shim.opts.windowsVerbatimArguments, true);
    assert.ok(shim.argv[3].startsWith('"') && shim.argv[3].endsWith('"'), shim.argv[3]);
    assert.ok(shim.argv[3].includes(path.join(dir, 'npm.cmd')), 'the resolved shim, not the bare name');
    assert.ok(shim.argv[3].includes(escapeArgForCmd('dev x')), 'arguments are escaped for cmd');

    // A name that resolves to a real executable is spawned directly: no cmd.exe,
    // no escaping, argv byte-identical.
    const exe = windowsSafeSpawn('tool', ['-e', 'console.log("hi")'], dir, env);
    assert.strictEqual(exe.file, 'tool');
    assert.deepStrictEqual(exe.argv, ['-e', 'console.log("hi")']);
    assert.deepStrictEqual(exe.opts, {});

    // A name that resolves to nothing is passed through untouched so spawn
    // reports ENOENT for the command the user typed -- wrapping it in a cmd.exe
    // line would turn "command not found: foo" into a cmd.exe diagnostic.
    assert.deepStrictEqual(windowsSafeSpawn('nosuchcmd', ['a'], dir, env), { file: 'nosuchcmd', argv: ['a'], opts: {} });

    // ComSpec is spelled either way depending on which shell exported it.
    assert.strictEqual(windowsSafeSpawn('npm', [], dir, { ...env, ComSpec: undefined, comspec: 'X:\\cmd.exe' }).file, 'X:\\cmd.exe');
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

test('a consumer that quits early does not strand the child (phantom -- cmd | head)', async () => {
  // `| head -1`, `| grep -q`, quitting the pager: the reader goes away, our
  // write to it gets EPIPE, and pump() stops writing to that destination.
  //
  // Stopping the WRITE is correct; stopping the READ is not. unpipe() also
  // clears flowing mode -- and the ring-buffer 'data' listener is not enough to
  // bring it back -- so without an explicit resume() the child's stdout is never
  // drained again. A child that writes synchronously to fd 1 (which is most
  // programs that are not node) then blocks forever on a full pipe and the run
  // never settles. Not a broken pipe: a hang, until the user notices and kills it.
  const dest = new Writable({
    write(c, e, cb) { cb(new Error('EPIPE')); },
  });
  const started = Date.now();
  const r = await runCommand(node, [
    '-e',
    // writeSync, deliberately: console.log buffers in memory and would exit
    // cleanly even with the pipe stalled, hiding the bug.
    'const fs=require("node:fs");for(let i=0;i<200000;i++)fs.writeSync(1,"line "+i+" "+"x".repeat(120)+"\\n");',
  ], { stdout: dest, stderr: sink() });

  assert.strictEqual(r.exitCode, 0, 'the child ran to completion instead of blocking on a full pipe');
  assert.ok(Date.now() - started < 20000, 'and settled promptly');
  // The tail is still captured: we stopped writing to the dead consumer, not reading.
  assert.ok(r.tail.includes('line 0') || r.tail.includes('line '), 'output still reached the ring buffer');
});

test('killTreeByPid takes the whole process group, not just the direct child', { skip: noSignals }, async () => {
  // spawnSync's own `timeout` signals the direct child ONLY. For `npm run dev`
  // that is npm, not the node server it started -- which keeps running and
  // keeps its port, so the user's next real `npm run dev` fails with EADDRINUSE
  // and nothing points at phantom. It happens on the documented SUCCESS path,
  // because "still running counts as fixed" means the timeout fires every time
  // a long-lived command is repaired.
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-orphan-'));
  const marker = path.join(dir, 'grandchild-alive');
  fs.writeFileSync(path.join(dir, 'child.js'),
    'const fs=require("node:fs");setInterval(()=>fs.writeFileSync(' + JSON.stringify(marker) + ',String(Date.now())),50);');
  fs.writeFileSync(path.join(dir, 'parent.js'),
    'require("node:child_process").spawn(process.execPath,[' + JSON.stringify(path.join(dir, 'child.js')) + '],{stdio:"ignore"});setInterval(()=>{},1000);');

  const r = spawnSync(node, [path.join(dir, 'parent.js')], {
    cwd: dir, encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  assert.ok(r.error && r.error.code === 'ETIMEDOUT', 'precondition: the run timed out');
  killTreeByPid(r.pid);

  // The grandchild keeps stamping a file while alive; if the tree really died,
  // the stamp stops changing.
  await new Promise((r2) => setTimeout(r2, 400));
  const first = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  await new Promise((r2) => setTimeout(r2, 400));
  const second = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  assert.strictEqual(first, second, 'the grandchild is gone, not still writing');
});
