'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const events = require('../src/events');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-events-'));
}

const ctx = { command: 'npm', args: ['run', 'dev'], errorLine: 'TypeError: boom', exitCode: 1, signal: null };

test('appendEvent creates .phantom/events.jsonl and returns the full event', () => {
  const root = tmp();
  const ev = events.appendEvent(root, events.crashEvent(ctx), { now: 1000 });
  assert.equal(ev.v, 1);
  assert.equal(ev.type, 'crash');
  assert.equal(ev.command, 'npm run dev');
  assert.equal(ev.error, 'TypeError: boom');
  assert.equal(ev.at, new Date(1000).toISOString());
  const lines = fs.readFileSync(events.eventsPath(root), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), ev);
});

test('readUnread returns events after the cursor, skipping malformed lines and stale events', () => {
  const root = tmp();
  const now = Date.now();
  const a = events.appendEvent(root, events.crashEvent(ctx), { now: now - 60000 });
  fs.appendFileSync(events.eventsPath(root), 'not json\n');
  const b = events.appendEvent(root, events.crashEvent(ctx), { now: now - 30000 });
  assert.deepEqual(events.readUnread(root, { now }).map((e) => e.id), [a.id, b.id]);

  assert.equal(events.markRead(root), true);
  assert.deepEqual(events.readUnread(root, { now }), []);

  const c = events.appendEvent(root, events.crashEvent(ctx), { now: now - 1000 });
  assert.deepEqual(events.readUnread(root, { now }).map((e) => e.id), [c.id]);

  events.appendEvent(root, events.crashEvent(ctx), { now: now - 2 * events.STALE_MS });
  const d = events.appendEvent(root, events.crashEvent(ctx), { now });
  assert.deepEqual(events.readUnread(root, { now }).map((e) => e.id), [c.id, d.id], 'stale event is hidden');
});

test('a missing cursor id (rotated away) means everything recent is unread', () => {
  const root = tmp();
  const now = Date.now();
  fs.mkdirSync(path.join(root, '.phantom'));
  fs.writeFileSync(events.cursorPath(root), 'gone\n');
  const a = events.appendEvent(root, events.crashEvent(ctx), { now });
  assert.deepEqual(events.readUnread(root, { now }).map((e) => e.id), [a.id]);
});

test('the log is capped at MAX_EVENTS lines', () => {
  const root = tmp();
  for (let i = 0; i < events.MAX_EVENTS + 5; i++) events.appendEvent(root, events.crashEvent(ctx), { now: i });
  const all = events.readEvents(root);
  assert.equal(all.length, events.MAX_EVENTS);
  assert.equal(all[all.length - 1].at, new Date(events.MAX_EVENTS + 4).toISOString());
});

test('readUnread on a repo with no events is empty and markRead is a no-op', () => {
  const root = tmp();
  assert.deepEqual(events.readUnread(root), []);
  assert.equal(events.markRead(root), false);
  assert.equal(fs.existsSync(path.join(root, '.phantom')), false);
});

test('findRoot walks up to the directory holding .phantom/events.jsonl', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx));
  const deep = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(fs.realpathSync(events.findRoot(deep)), fs.realpathSync(root));
  assert.equal(events.findRoot(tmp()), null);
});

test('recoveryEvent stores the report path relative to the root', () => {
  const root = tmp();
  const final = { status: 'fixed', branch: 'phantom/fix-x', reportPath: path.join(root, '.phantom', 'reports', 'r.md'), message: 'ok' };
  const ev = events.recoveryEvent(ctx, final, root);
  assert.equal(ev.type, 'recovery');
  assert.equal(ev.status, 'fixed');
  assert.equal(ev.report, '.phantom/reports/r.md');
  assert.equal(ev.branch, 'phantom/fix-x');
});

test('describeEvent and timeAgo produce the shared one-liners', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const at = new Date(now - 3 * 60000).toISOString();
  assert.equal(events.timeAgo(at, now), '3m ago');
  assert.equal(events.timeAgo(new Date(now - 5000).toISOString(), now), 'just now');
  assert.equal(events.timeAgo(new Date(now - 3 * 3600000).toISOString(), now), '3h ago');
  assert.equal(events.timeAgo(new Date(now - 48 * 3600000).toISOString(), now), '2d ago');

  const crash = { v: 1, id: 'x', type: 'crash', at, command: 'npm run dev', error: 'TypeError: boom', exit: 1, signal: null };
  assert.equal(events.describeEvent(crash, now), '`npm run dev` crashed 3m ago (exit 1) — TypeError: boom');
  const sig = Object.assign({}, crash, { error: null, exit: null, signal: 'SIGSEGV' });
  assert.equal(events.describeEvent(sig, now), '`npm run dev` crashed 3m ago (died from SIGSEGV)');

  const fixed = { v: 1, id: 'y', type: 'recovery', at, command: 'npm run dev', status: 'fixed', branch: 'phantom/fix-x', report: '.phantom/reports/r.md' };
  assert.equal(events.describeEvent(fixed, now), 'fixed `npm run dev` 3m ago · branch phantom/fix-x · report .phantom/reports/r.md');
  const unfixed = Object.assign({}, fixed, { status: 'unfixed', branch: null, report: null });
  assert.equal(events.describeEvent(unfixed, now), 'could not fix `npm run dev` 3m ago');
  const other = Object.assign({}, unfixed, { status: 'timeout' });
  assert.equal(events.describeEvent(other, now), 'recovery of `npm run dev` ended: timeout 3m ago');
});
