'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const announce = require('../src/announce');
const events = require('../src/events');

const ctx = { command: 'npm', args: ['start'], errorLine: 'TypeError: boom', exitCode: 1, signal: null };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-announce-')); }
function fakeNotifier() {
  const calls = [];
  return { calls, send: async (n) => { calls.push(n); return { ok: true, via: 'fake' }; } };
}

test('announceCrash logs an event and stays quiet unless notify is on', async () => {
  const root = tmp();
  require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: root });
  const notifier = fakeNotifier();
  const ev = await announce.announceCrash(ctx, { notify: false }, root, { notifier });
  assert.equal(ev.type, 'crash');
  assert.equal(events.readEvents(root).length, 1);
  assert.equal(notifier.calls.length, 0);
  assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.phantom\/$/m, 'event log is git-excluded so the tree stays clean');

  await announce.announceCrash(ctx, { notify: true }, root, { notifier });
  assert.equal(notifier.calls.length, 1);
  assert.match(notifier.calls[0].title, /^👻 phantom: crash detected/);
  assert.equal(notifier.calls[0].subtitle, 'npm start');
  assert.match(notifier.calls[0].message, /TypeError: boom/);
  assert.equal(notifier.calls[0].icon, announce.ICON);
  assert.ok(fs.existsSync(announce.ICON), 'notification icon ships with the package');
});

test('announceRecovery logs the outcome with a relative report path and notifies', async () => {
  const root = tmp();
  const notifier = fakeNotifier();
  const final = { status: 'fixed', branch: 'phantom/fix-x', reportPath: path.join(root, '.phantom', 'reports', 'r.md'), message: 'tests pass' };
  const ev = await announce.announceRecovery(ctx, { notify: true }, final, root, { notifier });
  assert.equal(ev.type, 'recovery');
  assert.equal(ev.report, '.phantom/reports/r.md');
  assert.equal(notifier.calls.length, 1);
  assert.equal(notifier.calls[0].title, '👻 phantom: fixed');
  assert.equal(notifier.calls[0].message, 'branch phantom/fix-x');

  await announce.announceRecovery(ctx, { notify: true }, { status: 'unfixed', branch: null, reportPath: null, message: 'gave up' }, root, { notifier });
  assert.equal(notifier.calls[1].title, '👻 phantom: could not fix it');
  assert.equal(notifier.calls[1].message, 'gave up');
});

test('a throwing notifier never breaks the announcement', async () => {
  const root = tmp();
  const notifier = { send: async () => { throw new Error('no dbus'); } };
  const ev = await announce.announceCrash(ctx, { notify: true }, root, { notifier });
  assert.equal(ev.type, 'crash');
});
