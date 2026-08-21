'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gatherContext } = require('../src/context');
const { loadConfig } = require('../src/config');

function repo() {
  // realpathSync.native, not realpathSync: on Windows os.tmpdir() is an 8.3
  // short name (C:\Users\RUNNER~1\...) and only the native call expands it to
  // the long form git reports. The stack-trace tails below are built from this
  // path, so both spellings have to be the same one for the repo-relative
  // hint-file stripping to have anything to strip.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'phantom-ctx-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test', start: 'node x' } }));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const runResult = (dir, tail) => ({
  command: 'npm', args: ['start'], cwd: dir, exitCode: 1, signal: null,
  startedAt: 1, endedAt: 2, durationMs: 1, tail, userInterrupted: false,
});

test('gatherContext builds the full CrashContext', () => {
  const dir = repo();
  const sub = path.join(dir, 'src');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  const tail = [
    'Error: secrets exploded',
    '    at load (' + dir + '/src/app.js:3:9)',
    '    at env (' + dir + '/.env:1:1)',
    '    at key (' + dir + '/config/server.key:1:1)',
    '    at dep (' + dir + '/node_modules/x/i.js:1:1)',
  ].join('\n');
  const ctx = gatherContext(runResult(sub, tail), loadConfig(dir));
  assert.strictEqual(ctx.crashed, true);
  assert.strictEqual(ctx.errorLine, 'Error: secrets exploded');
  assert.ok(ctx.stackTrace.includes('at load'));
  assert.deepStrictEqual(ctx.hintFiles, ['src/app.js']);
  assert.strictEqual(ctx.slug, 'error-secrets-exploded');
  assert.strictEqual(ctx.git.root, dir);
  assert.strictEqual(ctx.git.branch, 'main');
  assert.strictEqual(ctx.git.detached, false);
  assert.match(ctx.git.headSha, /^[0-9a-f]{40}$/);
  assert.strictEqual(ctx.git.dirty, true);
  assert.match(ctx.git.status, /dirty\.txt/);
  assert.strictEqual(ctx.git.recentCommits.length, 1);
  assert.deepStrictEqual(ctx.pkg, { name: 'demo', scripts: { test: 'node --test', start: 'node x' } });
  assert.strictEqual(ctx.testCommand, 'npm test');
  assert.ok(!Number.isNaN(Date.parse(ctx.capturedAt)));
  assert.strictEqual(ctx.exitCode, 1);
  assert.strictEqual(ctx.cwd, sub);
});

test('config testCommand wins; no package.json and no git degrade to nulls', () => {
  const dir = repo();
  const ctx = gatherContext(runResult(dir, 'Error: x\n'), loadConfig(dir, { testCommand: 'make check' }));
  assert.strictEqual(ctx.testCommand, 'make check');

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-plain-'));
  const ctx2 = gatherContext({ ...runResult(plain, 'nothing useful'), exitCode: null, signal: 'SIGSEGV' }, loadConfig(plain));
  assert.strictEqual(ctx2.git, null);
  assert.strictEqual(ctx2.pkg, null);
  assert.strictEqual(ctx2.testCommand, null);
  assert.strictEqual(ctx2.errorLine, null);
  assert.strictEqual(ctx2.slug, 'signal-sigsegv');
});

test('detached HEAD uses the sha as the branch to return to', () => {
  const dir = repo();
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir });
  const ctx = gatherContext(runResult(dir, ''), loadConfig(dir));
  assert.strictEqual(ctx.git.detached, true);
  assert.strictEqual(ctx.git.branch, ctx.git.headSha);
});

test('secrets in the output are scrubbed at the source (tail, stack trace, error line)', () => {
  const dir = repo();
  const tail = [
    '[boot] API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    '[boot] DATABASE_URL=postgres://admin:hunter2@db.internal/app',
    'Error: token sk-live-abcdefghijklmnopqrstuvwxyz rejected',
    '    at load (' + dir + '/src/app.js:3:9)',
  ].join('\n');
  const ctx = gatherContext(runResult(dir, tail), loadConfig(dir));
  const json = JSON.stringify(ctx);
  for (const secret of ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'hunter2', 'sk-live-abcdefghijklmnopqrstuvwxyz']) {
    assert.ok(!json.includes(secret), 'leaked ' + secret);
  }
  assert.ok(ctx.redactions >= 3, 'redactions=' + ctx.redactions);
  assert.match(ctx.errorLine, /^Error: token \[REDACTED\] rejected$/);
  assert.deepStrictEqual(ctx.hintFiles, ['src/app.js']);
  assert.ok(ctx.tail.includes('[REDACTED]'));
});

test('terminal escapes are stripped before redaction, parsing and slugging', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'app.js'), 'x\n');
  const E = '\x1b[31m';
  const R = '\x1b[39m';
  // A colour code in the middle of the token must not hide it from the redactor.
  const tail = [
    E + 'ANTHROPIC_API_KEY' + R + '=sk-ant-' + E + 'abcdefghijklmnopqrstuvwxyz0123456789' + R,
    E + 'TypeError' + R + ': kaboom',
    '    at explode (' + E + path.join(dir, 'app.js') + R + ':1:7)',
  ].join('\n') + '\n';
  const ctx = gatherContext(runResult(dir, tail), loadConfig(dir));
  assert.ok(!ctx.tail.includes('\x1b'), 'tail carries no escapes');
  assert.ok(!ctx.tail.includes('abcdefghijklmnopqrstuvwxyz0123456789'), 'the split secret is still redacted');
  assert.ok(ctx.redactions >= 1);
  assert.strictEqual(ctx.errorLine, 'TypeError: kaboom');
  assert.deepStrictEqual(ctx.hintFiles, ['app.js']);
  assert.strictEqual(ctx.slug, 'typeerror-kaboom');
  assert.ok(!ctx.stackTrace.includes('\x1b'));
});
