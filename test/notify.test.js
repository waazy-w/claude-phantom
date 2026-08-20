'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendWebhook, buildPayload } = require('../src/notify');

test('sendWebhook skips when no url is configured', async () => {
  assert.deepEqual(await sendWebhook(null, { a: 1 }), { ok: false, skipped: true });
});

test('sendWebhook posts JSON and reports status', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; };
  const res = await sendWebhook('https://hooks.example/x', { status: 'fixed' }, { fetchImpl });
  assert.deepEqual(res, { ok: true, status: 200 });
  assert.equal(seen.url, 'https://hooks.example/x');
  assert.equal(seen.init.method, 'POST');
  assert.equal(JSON.parse(seen.init.body).status, 'fixed');
});

test('sendWebhook times out without throwing', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const res = await sendWebhook('https://hooks.example/slow', {}, { fetchImpl, timeoutMs: 20 });
  assert.deepEqual(res, { ok: false, error: 'timeout' });
});

test('sendWebhook swallows network errors', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const res = await sendWebhook('https://hooks.example/down', {}, { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

test('buildPayload is flat and complete', () => {
  const ctx = { command: 'npm', args: ['start'], errorLine: 'TypeError: x', exitCode: 1, signal: null, cwd: '/r', git: { root: '/r', branch: 'main' } };
  const result = { status: 'fixed', branch: 'phantom/fix-x', reportPath: '/r/.phantom/reports/a.md', iterations: 1, testsPassed: true, message: 'ok' };
  const p = buildPayload(ctx, result);
  assert.equal(p.event, 'phantom.recovery');
  assert.equal(p.command, 'npm start');
  assert.equal(p.baseBranch, 'main');
  assert.ok(Object.values(p).every((v) => typeof v !== 'object' || v === null));
});
