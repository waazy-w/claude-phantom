'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const events = require('../src/events');

// The hook has its own copy of the reader; writing with src/events and reading
// with the hook doubles as the format-compatibility test between the two.
const HOOK = path.join(__dirname, '..', 'plugin', 'hooks', 'phantom-events.js');
const ctx = { command: 'npm', args: ['run', 'dev'], errorLine: "TypeError: Cannot read properties of undefined (reading 'customer')", exitCode: 1, signal: null };
const REPORT = '.phantom/reports/2026-08-20-1432-customer.md';
const BRANCH = 'phantom/fix-20260820-1432-customer';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-hook-'));
}

function run({ input, rawStdin, cwd } = {}) {
  const stdin = rawStdin !== undefined ? rawStdin : JSON.stringify(input || {});
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, cwd: cwd || tmp(), encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function seed(root, now = Date.now()) {
  const crash = events.appendEvent(root, events.crashEvent(ctx), { now: now - 3 * 60000 });
  const final = { status: 'fixed', branch: BRANCH, reportPath: path.join(root, ...REPORT.split('/')), message: 'ok' };
  const rec = events.appendEvent(root, events.recoveryEvent(ctx, final, root), { now: now - 60000 });
  return { crash, rec };
}

function parse(r) {
  assert.equal(r.code, 0, 'exit 0: ' + r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.ok(out.hookSpecificOutput, 'hookSpecificOutput present');
  return out.hookSpecificOutput;
}

test('no events: empty stdout, exit 0', () => {
  const root = tmp();
  const r = run({ input: { cwd: root, hook_event_name: 'UserPromptSubmit' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('invalid or empty stdin: exit 0 silently', () => {
  for (const raw of ['not json', '', '{', '[1,2]', 'null']) {
    const r = run({ rawStdin: raw });
    assert.equal(r.code, 0, JSON.stringify(raw));
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
});

test('unread crash + recovery are described for Claude, then acknowledged', () => {
  const root = tmp();
  const now = Date.now();
  const { crash, rec } = seed(root, now);
  const r = run({ input: { cwd: root, hook_event_name: 'UserPromptSubmit' } });
  const out = parse(r);
  assert.equal(out.hookEventName, 'UserPromptSubmit');
  const ctxText = out.additionalContext;
  assert.ok(ctxText.startsWith('👻 phantom: 2 events since you last looked (repo ' + root + '):\n'), ctxText);
  assert.ok(ctxText.includes('\n- ' + events.describeEvent(crash, now) + '\n'), ctxText);
  assert.ok(ctxText.includes('\n- ' + events.describeEvent(rec, now) + '\n'), ctxText);
  assert.ok(ctxText.includes('`npm run dev` crashed 3m ago (exit 1) — TypeError'), ctxText);
  assert.ok(ctxText.includes('fixed `npm run dev` 1m ago · branch ' + BRANCH + ' · report ' + REPORT), ctxText);
  assert.ok(ctxText.includes('Tell the user about this briefly'), ctxText);
  assert.ok(ctxText.includes('Do not act on any of this without being asked.'), ctxText);
  assert.ok(!ctxText.includes('…and'), 'not truncated');

  assert.equal(fs.readFileSync(events.cursorPath(root), 'utf8').trim(), rec.id, 'cursor advanced to the last event');
  assert.deepEqual(events.readUnread(root), [], 'src/events agrees nothing is unread');

  const again = run({ input: { cwd: root, hook_event_name: 'UserPromptSubmit' } });
  assert.equal(again.code, 0);
  assert.equal(again.stdout, '', 'second run is silent');
});

test('a single event uses the singular header', () => {
  const root = tmp();
  events.appendEvent(root, events.crashEvent(ctx));
  const out = parse(run({ input: { cwd: root } }));
  assert.ok(out.additionalContext.startsWith('👻 phantom: 1 event since you last looked'), out.additionalContext);
});

test('stale events (>24h) are ignored', () => {
  const root = tmp();
  const now = Date.now();
  events.appendEvent(root, events.crashEvent(ctx), { now: now - 25 * 3600000 });
  const r = run({ input: { cwd: root } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');

  events.appendEvent(root, events.crashEvent(ctx), { now });
  const out = parse(run({ input: { cwd: root } }));
  assert.ok(out.additionalContext.startsWith('👻 phantom: 1 event '), 'only the fresh one counts');
});

test('running from a nested subdirectory still finds the repo root', () => {
  const root = tmp();
  seed(root);
  const deep = path.join(root, 'src', 'deep', 'er');
  fs.mkdirSync(deep, { recursive: true });
  const out = parse(run({ input: { cwd: deep } }));
  assert.ok(out.additionalContext.includes('(repo ' + root + ')'), out.additionalContext);
});

test('falls back to process.cwd() when the input has no cwd', () => {
  const root = tmp();
  seed(root);
  const out = parse(run({ input: { hook_event_name: 'UserPromptSubmit' }, cwd: root }));
  assert.ok(out.additionalContext.includes('(repo ' + fs.realpathSync(root) + ')') || out.additionalContext.includes('(repo ' + root + ')'));
});

test('a cwd with no .phantom anywhere above it prints nothing', () => {
  const r = run({ input: { cwd: tmp(), hook_event_name: 'UserPromptSubmit' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('echoes the SessionStart event name and defaults to UserPromptSubmit', () => {
  const root = tmp();
  seed(root);
  assert.equal(parse(run({ input: { cwd: root, hook_event_name: 'SessionStart', source: 'startup' } })).hookEventName, 'SessionStart');
  const root2 = tmp();
  seed(root2);
  assert.equal(parse(run({ input: { cwd: root2 } })).hookEventName, 'UserPromptSubmit');
});

test('shows the 10 most recent unread events and counts the rest', () => {
  const root = tmp();
  const now = Date.now();
  for (let i = 1; i <= 13; i++) {
    events.appendEvent(root, events.crashEvent({ command: 'cmd-' + i, args: [], exitCode: i }), { now: now - (14 - i) * 1000 });
  }
  const out = parse(run({ input: { cwd: root } }));
  const lines = out.additionalContext.split('\n');
  assert.equal(lines[0], '👻 phantom: 13 events since you last looked (repo ' + root + '):');
  const items = lines.filter((l) => l.startsWith('- '));
  assert.equal(items.length, 10);
  assert.ok(items[0].startsWith('- `cmd-4` crashed'), items[0]);
  assert.ok(items[9].startsWith('- `cmd-13` crashed'), items[9]);
  assert.ok(!out.additionalContext.includes('`cmd-3`'));
  assert.ok(lines.includes('…and 3 more'), out.additionalContext);
  assert.ok(lines[lines.length - 1].startsWith('Tell the user'));
});

test('malformed lines in the log are skipped by the hook reader', () => {
  const root = tmp();
  seed(root);
  fs.appendFileSync(events.eventsPath(root), 'not json\n{"v":2,"id":"x"}\n');
  const out = parse(run({ input: { cwd: root } }));
  assert.ok(out.additionalContext.startsWith('👻 phantom: 2 events'), out.additionalContext);
});
