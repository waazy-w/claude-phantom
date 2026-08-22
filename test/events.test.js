'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
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

test('the log stays bounded, and trimming keeps the newest events', () => {
  // The cap is a ceiling, not an exact length. Every append is a bare
  // fs.appendFileSync -- that atomicity is what makes concurrent writers safe --
  // and the whole-file rewrite that enforces MAX_EVENTS runs only once the log
  // crosses TRIM_AT. So between trims the file is legitimately longer than
  // MAX_EVENTS, and what must hold is that it never grows without bound and
  // never loses the recent end.
  const root = tmp();
  for (let i = 0; i < events.MAX_EVENTS + 5; i++) events.appendEvent(root, events.crashEvent(ctx), { now: i });
  let all = events.readEvents(root);
  assert.ok(all.length <= events.TRIM_AT, 'bounded: ' + all.length);
  assert.equal(all[all.length - 1].at, new Date(events.MAX_EVENTS + 4).toISOString());

  const total = events.TRIM_AT + 20;
  for (let i = events.MAX_EVENTS + 5; i < total; i++) events.appendEvent(root, events.crashEvent(ctx), { now: i });
  all = events.readEvents(root);
  assert.ok(all.length < total, 'a trim actually happened: ' + all.length + ' of ' + total + ' appended');
  assert.ok(all.length <= events.TRIM_AT, 'and it stays under the ceiling: ' + all.length);
  assert.equal(all[all.length - 1].at, new Date(total - 1).toISOString(), 'newest survives the trim');
  assert.ok(!fs.existsSync(path.join(root, '.phantom', 'events.lock')), 'the lock is released');
  assert.equal(fs.readdirSync(path.join(root, '.phantom')).filter((f) => f.includes('.tmp')).length, 0, 'no temp file left behind');
});

test('concurrent writers do not destroy each other\'s events', async () => {
  // This was the defect: appendEvent read the whole file, concatenated, and
  // wrote it back with no lock, so a writer could read a snapshot another was
  // mid-truncate on and write that shorter version back as the authoritative
  // log. Two phantom-wrapped commands crashing at once -- a monorepo, a CI
  // matrix, two terminals -- silently lost most of the crash history.
  const root = tmp();
  // Seed to the cap. Below MAX_EVENTS the old code took an appendFileSync fast
  // path and looked fine; the whole-file rewrite -- the destructive part -- only
  // ran once the log was full, which is exactly when a busy repo hits it.
  const seed = events.MAX_EVENTS;
  for (let i = 0; i < seed; i++) events.appendEvent(root, events.crashEvent(ctx), { now: i });

  const WRITERS = 6;
  const PER = 10;
  const script = [
    'const events = require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'events.js')) + ');',
    // `node -e` puts the first user argument at argv[1]: there is no script
    // path to skip, so slice(2) would silently drop the root.
    'const [root, tag] = process.argv.slice(1);',
    'for (let i = 0; i < ' + PER + '; i++) {',
    '  events.appendEvent(root, { type: "crash", command: tag + ":" + i, error: null, exit: 1, signal: null });',
    '}',
  ].join('\n');

  await Promise.all(Array.from({ length: WRITERS }, (_, w) => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, root, 'w' + w], (err) => (err ? reject(err) : resolve()));
  })));

  const all = events.readEvents(root);
  const written = new Set(all.map((e) => e.command));
  const missing = [];
  for (let w = 0; w < WRITERS; w++) {
    for (let i = 0; i < PER; i++) {
      const tag = 'w' + w + ':' + i;
      if (!written.has(tag)) missing.push(tag);
    }
  }
  assert.deepEqual(missing, [], missing.length + ' of ' + (WRITERS * PER) + ' concurrent events were lost');
  assert.ok(all.length <= events.TRIM_AT, 'and the log is still bounded: ' + all.length);
});

test('one enormous error line cannot flood the log or the prompt', () => {
  // `error` is a line of the crashed program's own output and nothing bounded
  // it, so a minified bundle or a single-line JSON blob went verbatim into the
  // log and from there into additionalContext on every prompt in that repo --
  // measured at 200,142 bytes of events.jsonl for one crash, roughly 50k tokens
  // of the user's context window per event.
  const root = tmp();
  const huge = 'Error: ' + 'q'.repeat(200000);
  const ev = events.appendEvent(root, { type: 'crash', command: 'node ' + 'y'.repeat(5000), error: huge, exit: 1, signal: null });

  assert.ok(ev.error.length <= events.MAX_ERROR_CHARS, 'error clamped: ' + ev.error.length);
  assert.ok(ev.command.length <= events.MAX_COMMAND_CHARS, 'command clamped: ' + ev.command.length);
  assert.match(ev.error, /…$/, 'and the truncation is visible, not silent');
  const bytes = fs.statSync(path.join(root, '.phantom', 'events.jsonl')).size;
  assert.ok(bytes < 4096, 'one event stays small: ' + bytes + ' bytes');
  assert.equal(events.readEvents(root).length, 1, 'and it is still a valid, readable event');
});

test('a newline in an error line cannot forge a second log entry', () => {
  const root = tmp();
  const ev = events.appendEvent(root, {
    type: 'crash', command: 'node app.js', exit: 1, signal: null,
    error: 'boom\n' + JSON.stringify({ v: 1, id: 'forged', at: new Date().toISOString(), type: 'crash', command: 'FORGED' }),
  });
  assert.ok(!ev.error.includes('\n'));
  const all = events.readEvents(root);
  assert.equal(all.length, 1, 'one line in, one event out');
  assert.ok(!all.some((e) => e.command === 'FORGED'));
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
  assert.equal(ev.session, null);
  assert.equal(events.recoveryEvent(ctx, Object.assign({ sessionId: 'abc' }, final), root).session, 'abc');
});

test('recoveryEvent records the base the fix was cut from', () => {
  // Without it the briefing named only the fix branch, so `git diff <base>..`
  // had nothing to fill <base> with and Claude guessed `main` -- wrong on every
  // crash that happened on a feature branch.
  const root = tmp();
  const final = { status: 'fixed', branch: 'phantom/fix-x', reportPath: null, message: 'ok' };
  const onFeature = Object.assign({}, ctx, { git: { branch: 'feature/checkout', detached: false, headSha: 'stale000' } });

  const passed = events.recoveryEvent(onFeature, Object.assign({ base: 'feature/checkout', baseSha: 'abc123def4567' }, final), root);
  assert.equal(passed.base, 'feature/checkout');
  assert.equal(passed.baseSha, 'abc123def4567', 'the full sha is stored; shortening is a rendering choice');

  // recovery.js derives its own origRef from exactly these ctx.git fields, so
  // the branch half is recoverable here even when nothing is passed.
  const derived = events.recoveryEvent(onFeature, final, root);
  assert.equal(derived.base, 'feature/checkout');
  // ...but the sha is not: `phantom recover` replays captures that can be days
  // old, so ctx.git.headSha is HEAD at capture time, not the branch point.
  assert.equal(derived.baseSha, null, 'never invented from a stale snapshot');
  assert.notEqual(derived.baseSha, 'stale000');

  // Detached HEAD has no branch name to report, and no git info at all is fine.
  const detached = Object.assign({}, ctx, { git: { branch: null, detached: true, headSha: 'deadbeef' } });
  assert.equal(events.recoveryEvent(detached, final, root).base, null);
  assert.equal(events.recoveryEvent(ctx, final, root).base, null);
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

test('describeEvent renders the base and the session id', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const at = new Date(now - 3 * 60000).toISOString();
  const fixed = {
    v: 1, id: 'y', type: 'recovery', at, command: 'npm run dev', status: 'fixed',
    branch: 'phantom/fix-x', base: 'feature/checkout', baseSha: 'abc123def4567890',
    report: '.phantom/reports/r.md', session: 's-1234',
  };
  assert.equal(events.describeEvent(fixed, now),
    'fixed `npm run dev` 3m ago · branch phantom/fix-x · base feature/checkout (abc123def4) · report .phantom/reports/r.md · session s-1234');

  // Either half of the base alone still reads, and the sha alone is enough to
  // diff against -- a dry run has no branch but still has a base commit.
  assert.equal(events.describeEvent(Object.assign({}, fixed, { baseSha: null }), now),
    'fixed `npm run dev` 3m ago · branch phantom/fix-x · base feature/checkout · report .phantom/reports/r.md · session s-1234');
  assert.equal(events.describeEvent(Object.assign({}, fixed, { base: null }), now),
    'fixed `npm run dev` 3m ago · branch phantom/fix-x · base abc123def4 · report .phantom/reports/r.md · session s-1234');

  // An event from a phantom that predates any of this must degrade to the old
  // line, never to `base undefined` / `session undefined` in a briefing Claude
  // reads as fact.
  const old = { v: 1, id: 'y', type: 'recovery', at, command: 'npm run dev', status: 'fixed', branch: 'phantom/fix-x', report: '.phantom/reports/r.md' };
  const line = events.describeEvent(old, now);
  assert.equal(line, 'fixed `npm run dev` 3m ago · branch phantom/fix-x · report .phantom/reports/r.md');
  assert.ok(!line.includes('undefined'), line);
  assert.ok(!line.includes('null'), line);
});

test('a torn last line does not swallow the next event', () => {
  // appendFileSync concatenates onto whatever is already there, so a log whose
  // last line lost its newline -- a writer killed mid-write, a full disk --
  // merged the next event into the broken one, and BOTH became unparseable.
  // The crash simply never reached Claude or the status line.
  const root = tmp();
  fs.mkdirSync(path.join(root, '.phantom'), { recursive: true });
  fs.writeFileSync(path.join(root, '.phantom', 'events.jsonl'),
    JSON.stringify({ v: 1, id: 'a', at: new Date().toISOString(), type: 'crash', command: 'npm test' }) + '\n'
    + '{"v":1,"id":"partial","at":"' + new Date().toISOString() + '","type":"crash","command":"vite bu');

  const written = events.appendEvent(root, { type: 'crash', command: 'pytest', error: null, exit: 1, signal: null });
  assert.ok(written, 'the append succeeded');

  const all = events.readEvents(root);
  assert.ok(all.some((e) => e.command === 'pytest'), 'the new event survived the tear');
  assert.ok(all.some((e) => e.command === 'npm test'), 'and so did the intact one before it');
  // The torn record itself is unrecoverable; losing one is the cost of the
  // tear, losing the NEXT one was the bug.
  assert.ok(!all.some((e) => e.id === 'partial'));
});

test('one unreadable line does not replay every event the user already saw', () => {
  // The cursor was a bare event id, and findIndex returning -1 was treated
  // identically to "never acknowledged anything" -- so if the cursor's own line
  // became unparseable while its neighbours survived, the whole retained log
  // came back as unread: a 200-event briefing in the next prompt and (+199) on
  // the status line. The cursor carries its timestamp now, so a missing id
  // degrades to "newer than the acknowledged time" instead.
  const root = tmp();
  const t0 = Date.parse('2026-08-22T00:00:00Z');
  for (let i = 0; i < 40; i++) {
    events.appendEvent(root, { type: 'crash', command: 'seen' + i, error: null, exit: 1, signal: null }, { now: t0 + i * 1000 });
  }
  events.markRead(root);
  for (let i = 0; i < 5; i++) {
    events.appendEvent(root, { type: 'crash', command: 'new' + i, error: null, exit: 1, signal: null }, { now: t0 + 100000 + i * 1000 });
  }

  // One line goes bad; its neighbours are fine.
  const file = path.join(root, '.phantom', 'events.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines[lines.findIndex((l) => l.includes('"seen39"'))] = '{corrupted';
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const unread = events.readUnread(root, { now: t0 + 200000 });
  assert.equal(unread.filter((e) => e.command.startsWith('seen')).length, 0,
    'nothing the user already acknowledged comes back');
  assert.equal(unread.length, 5, 'only the genuinely new events: ' + unread.map((e) => e.command).join(', '));
});

test('the cursor records when it was set, not just what it named', () => {
  const root = tmp();
  events.appendEvent(root, { type: 'crash', command: 'x', error: null, exit: 1, signal: null });
  events.markRead(root);
  const raw = fs.readFileSync(path.join(root, '.phantom', 'events.cursor'), 'utf8').trim();
  const [id, at] = raw.split(/\s+/);
  assert.match(id, /\S/);
  assert.ok(Number.isFinite(Date.parse(at)), 'a parseable timestamp: ' + raw);
  // A bare id, written by an older phantom, must still be understood.
  fs.writeFileSync(path.join(root, '.phantom', 'events.cursor'), id + '\n');
  assert.equal(events.readUnread(root).length, 0, 'the old one-field format still acknowledges');
});
