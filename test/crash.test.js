'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectCrash, extractStackTrace, slugify, summarizeExit } = require('../src/crash');

const NODE_THROW = `
> app@1.0.0 start
> node server.js

listening on 3000
/Users/me/proj/src/server.js:12
  const x = undefined.foo;
                      ^

TypeError: Cannot read properties of undefined (reading 'foo')
    at start (/Users/me/proj/src/server.js:12:23)
    at Object.<anonymous> (/Users/me/proj/src/server.js:20:1)
    at Module._compile (node:internal/modules/cjs/loader:1554:14)
    at Object..js (node:internal/modules/cjs/loader:1706:10)
    at /Users/me/proj/node_modules/foo/index.js:3:3

Node.js v22.0.0
`;

test('detectCrash', () => {
  assert.strictEqual(detectCrash({ exitCode: 0, signal: null, userInterrupted: false }), false);
  assert.strictEqual(detectCrash({ exitCode: 1, signal: null, userInterrupted: false }), true);
  assert.strictEqual(detectCrash({ exitCode: null, signal: 'SIGSEGV', userInterrupted: false }), true);
  assert.strictEqual(detectCrash({ exitCode: null, signal: 'SIGINT', userInterrupted: true }), false);
  assert.strictEqual(detectCrash({ exitCode: 130, signal: null, userInterrupted: true }), false);
});

test('node throw: preamble, error line, at-lines, repo-relative hint files', () => {
  const r = extractStackTrace(NODE_THROW, { cwd: '/Users/me/proj' });
  assert.strictEqual(r.errorLine, "TypeError: Cannot read properties of undefined (reading 'foo')");
  assert.ok(r.stackTrace.startsWith('/Users/me/proj/src/server.js:12\n'));
  assert.ok(r.stackTrace.includes('    at Object.<anonymous>'));
  assert.ok(!r.stackTrace.includes('Node.js v22'));
  assert.ok(!r.stackTrace.includes('listening on 3000'));
  assert.deepStrictEqual(r.hintFiles, ['src/server.js']);
});

test('picks the LAST error block and strips file:// urls', () => {
  const text = [
    'Error: first',
    '    at a (/p/one.js:1:1)',
    '',
    'recovered, continuing',
    'Error: second',
    '    at b (file:///p/two.mjs:2:2)',
    '    at c (/p/three.js:3:3)',
  ].join('\n');
  const r = extractStackTrace(text, { cwd: '/p' });
  assert.strictEqual(r.errorLine, 'Error: second');
  assert.ok(!r.stackTrace.includes('first'));
  assert.deepStrictEqual(r.hintFiles, ['two.mjs', 'three.js']);
});

test('unhandled rejection block', () => {
  const text = [
    'node:internal/process/promises:391',
    '    triggerUncaughtException(err, true /* fromPromise */);',
    '    ^',
    '',
    '[UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "boom".] {',
    "  code: 'ERR_UNHANDLED_REJECTION'",
    '}',
    '',
    'Node.js v22.0.0',
  ].join('\n');
  const r = extractStackTrace(text);
  assert.ok(r.errorLine.startsWith('UnhandledPromiseRejection: This error originated'));
  assert.ok(r.stackTrace.includes("code: 'ERR_UNHANDLED_REJECTION'"));
  assert.ok(r.stackTrace.endsWith('}'));
  assert.deepStrictEqual(r.hintFiles, []);
});

test('python traceback starts at Traceback and ends at the final error line', () => {
  const text = [
    'starting',
    'Traceback (most recent call last):',
    '  File "/home/me/proj/app/main.py", line 10, in <module>',
    '    run()',
    '  File "/home/me/proj/app/core.py", line 4, in run',
    '    return 1 / 0',
    'ZeroDivisionError: division by zero',
    '',
  ].join('\n');
  const r = extractStackTrace(text, { cwd: '/home/me/proj' });
  assert.strictEqual(r.errorLine, 'ZeroDivisionError: division by zero');
  assert.ok(r.stackTrace.startsWith('Traceback (most recent call last):'));
  assert.ok(r.stackTrace.endsWith('ZeroDivisionError: division by zero'));
  assert.deepStrictEqual(r.hintFiles, ['app/main.py', 'app/core.py']);
});

test('go panic, rust panic, java exception', () => {
  const go = extractStackTrace([
    'panic: runtime error: index out of range [3] with length 3',
    '',
    'goroutine 1 [running]:',
    'main.main()',
    '\t/home/me/proj/cmd/main.go:12 +0x1d',
    'exit status 2',
  ].join('\n'), { cwd: '/home/me/proj' });
  assert.strictEqual(go.errorLine, 'panic: runtime error: index out of range [3] with length 3');
  assert.ok(go.stackTrace.includes('goroutine 1 [running]:'));
  assert.ok(go.stackTrace.includes('main.main()'));
  assert.ok(!go.stackTrace.includes('exit status'));
  assert.deepStrictEqual(go.hintFiles, ['cmd/main.go']);

  const rust = extractStackTrace([
    "thread 'main' panicked at src/main.rs:4:5:",
    'explicit panic',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  ].join('\n'));
  assert.strictEqual(rust.errorLine, "thread 'main' panicked at src/main.rs:4:5: explicit panic");
  assert.deepStrictEqual(rust.hintFiles, ['src/main.rs']);

  const java = extractStackTrace([
    'Exception in thread "main" java.lang.IllegalStateException: boom',
    '\tat com.example.App.run(App.java:15)',
    '\tat com.example.App.main(App.java:5)',
    'Caused by: java.lang.NullPointerException',
    '\tat com.example.App.init(App.java:9)',
    '\t... 2 more',
  ].join('\n'));
  assert.strictEqual(java.errorLine, 'Exception in thread "main" java.lang.IllegalStateException: boom');
  assert.ok(java.stackTrace.includes('Caused by:'));
  assert.ok(java.stackTrace.endsWith('... 2 more'));
  assert.deepStrictEqual(java.hintFiles, ['App.java']);
});

test('no recognizable error yields nulls', () => {
  const r = extractStackTrace('all good\nbye\n');
  assert.deepStrictEqual(r, { stackTrace: null, errorLine: null, hintFiles: [] });
  assert.deepStrictEqual(extractStackTrace(''), { stackTrace: null, errorLine: null, hintFiles: [] });
});

test('slugify', () => {
  assert.strictEqual(slugify("TypeError: Cannot read properties of undefined (reading 'foo')"), 'typeerror-cannot-read-properties');
  assert.strictEqual(slugify('Error: ENOENT no such file or directory open /tmp/x'), 'error-enoent-no-such-file-or');
  assert.ok(slugify('Error: ' + 'x'.repeat(100)).length <= 32);
  assert.strictEqual(slugify('Error: boom!'), 'error-boom');
  assert.strictEqual(slugify(null, { exitCode: 1, signal: null }), 'exit-1');
  assert.strictEqual(slugify('', { exitCode: null, signal: 'SIGSEGV' }), 'signal-sigsegv');
  assert.strictEqual(slugify('???', {}), 'crash');
  assert.match(slugify('Ünïcode  --- Error'), /^[a-z0-9-]+$/);
});

test('summarizeExit', () => {
  assert.strictEqual(summarizeExit({ exitCode: 1, signal: null }), 'exit code 1');
  assert.strictEqual(summarizeExit({ exitCode: 0, signal: null }), 'exit code 0');
  assert.strictEqual(summarizeExit({ exitCode: null, signal: 'SIGSEGV' }), 'killed by SIGSEGV (11)');
  assert.strictEqual(summarizeExit({ exitCode: null, signal: null }), 'unknown exit');
});

test('a very long line without separators does not stall extraction (regex backtracking)', () => {
  const blob = 'y'.repeat(262144);
  const t0 = Date.now();
  const r = extractStackTrace(blob + '\n');
  const dt = Date.now() - t0;
  assert.ok(dt < 1000, 'took ' + dt + 'ms');
  assert.deepStrictEqual(r.hintFiles, []);
  // Short lines next to the blob are still scanned.
  const r2 = extractStackTrace(blob + '\n    at f (src/a.js:1:2)\n');
  assert.deepStrictEqual(r2.hintFiles, ['src/a.js']);
  const t1 = Date.now();
  extractStackTrace(Buffer.alloc(200000, 'A').toString('base64').slice(0, 262144) + '\nTypeError: x\n');
  assert.ok(Date.now() - t1 < 1000);
});
