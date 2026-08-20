#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook (UserPromptSubmit / SessionStart) that surfaces unread
 * phantom crash/recovery events to Claude as `additionalContext`.
 *
 * Self-contained on purpose: a plugin can be installed without `src/` next
 * to it, so the reader below mirrors `src/events.js`. Keep the two in sync.
 *
 * Contract: read the hook event JSON on stdin, print nothing when there is
 * nothing to say, otherwise print
 *   {"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}
 * and advance `.phantom/events.cursor` so each event is reported once.
 * Never exits non-zero and never writes to stderr on the normal path: a
 * failing UserPromptSubmit hook would block the user's prompt.
 */

const fs = require('node:fs');
const path = require('node:path');

const EVENTS_REL = path.join('.phantom', 'events.jsonl');
const CURSOR_REL = path.join('.phantom', 'events.cursor');
const STALE_MS = 24 * 60 * 60 * 1000;
const MAX_SHOWN = 10;
const STDIN_TIMEOUT_MS = 2000;

const INSTRUCTIONS = 'Tell the user about this briefly at the start of your reply (one or two lines, keep the 👻), '
  + 'then continue with their request. If a fix branch exists, offer `git diff <base>..<branch>` and `git merge <branch>`; '
  + 'if a report exists, offer to open it. Do not act on any of this without being asked.';

function eventsPath(root) { return path.join(root, EVENTS_REL); }
function cursorPath(root) { return path.join(root, CURSOR_REL); }

/** Walk up from `start` to the nearest directory that has a `.phantom/events.jsonl`. */
function findRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(eventsPath(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** All parseable v1 events, oldest first. Malformed lines are skipped. */
function readEvents(root) {
  let text;
  try {
    text = fs.readFileSync(eventsPath(root), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.v === 1 && typeof ev.id === 'string' && typeof ev.at === 'string') out.push(ev);
    } catch { /* skip */ }
  }
  return out;
}

function readCursor(root) {
  try {
    return fs.readFileSync(cursorPath(root), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Events after the cursor that are younger than STALE_MS. */
function unreadOf(events, cursor, now) {
  const idx = cursor ? events.findIndex((e) => e.id === cursor) : -1;
  return events.slice(idx + 1).filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && now - t <= STALE_MS;
  });
}

/** Acknowledge everything in `events`. Best-effort. */
function markRead(root, events) {
  if (!events.length) return;
  try {
    fs.mkdirSync(path.dirname(cursorPath(root)), { recursive: true });
    fs.writeFileSync(cursorPath(root), events[events.length - 1].id + '\n');
  } catch { /* best-effort */ }
}

function timeAgo(iso, now) {
  const ms = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

/** Same one-liner as src/events.js describeEvent. */
function describeEvent(ev, now) {
  const when = timeAgo(ev.at, now);
  if (ev.type === 'crash') {
    const why = ev.signal ? 'died from ' + ev.signal : 'exit ' + (ev.exit === null || ev.exit === undefined ? '?' : ev.exit);
    return '`' + ev.command + '` crashed ' + when + ' (' + why + ')' + (ev.error ? ' — ' + ev.error : '');
  }
  const head = {
    fixed: 'fixed `' + ev.command + '`',
    'dry-run': 'proposed a fix for `' + ev.command + '` (dry run)',
    unfixed: 'could not fix `' + ev.command + '`',
    aborted: 'recovery of `' + ev.command + '` was aborted',
  }[ev.status] || ('recovery of `' + ev.command + '` ended: ' + ev.status);
  const parts = [head + ' ' + when];
  if (ev.branch) parts.push('branch ' + ev.branch);
  if (ev.report) parts.push('report ' + ev.report);
  return parts.join(' · ');
}

function buildContext(root, unread, now) {
  const shown = unread.slice(-MAX_SHOWN);
  const hidden = unread.length - shown.length;
  const n = unread.length;
  const lines = ['👻 phantom: ' + n + (n === 1 ? ' event' : ' events') + ' since you last looked (repo ' + root + '):'];
  for (const ev of shown) lines.push('- ' + describeEvent(ev, now));
  if (hidden > 0) lines.push('…and ' + hidden + ' more');
  lines.push(INSTRUCTIONS);
  return lines.join('\n');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(data); } };
    if (process.stdin.isTTY) return done();
    setTimeout(done, STDIN_TIMEOUT_MS).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') input = parsed;
    }
  } catch {
    input = {};
  }
  const start = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = findRoot(start);
  if (!root) return;
  const now = Date.now();
  const events = readEvents(root);
  const unread = unreadOf(events, readCursor(root), now);
  if (!unread.length) return;
  const hookEventName = typeof input.hook_event_name === 'string' && input.hook_event_name ? input.hook_event_name : 'UserPromptSubmit';
  const out = { hookSpecificOutput: { hookEventName, additionalContext: buildContext(root, unread, now) } };
  process.stdout.write(JSON.stringify(out) + '\n');
  markRead(root, events);
}

if (require.main === module) {
  main()
    .catch((err) => { process.stderr.write('phantom-events hook: ' + (err && err.message) + '\n'); })
    .then(() => process.exit(0));
}

module.exports = { findRoot, readEvents, readCursor, unreadOf, describeEvent, timeAgo, buildContext, MAX_SHOWN, STALE_MS };
