'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { commandLineOf } = require('./context');

/**
 * Crash/recovery event log: `.phantom/events.jsonl` at the repo root.
 *
 * Phantom appends one line per event. Readers (the Claude Code plugin hook,
 * `phantom-status`) show events that are newer than the acknowledged cursor
 * and younger than STALE_MS, so a crash from last week never resurfaces.
 *
 * Format is versioned (`v: 1`) and deliberately flat. The plugin hook has
 * its own copy of the reader so it works without `src/` on disk; keep
 * `plugin/hooks/phantom-events.js` in sync when changing this file.
 *
 * @typedef {object} PhantomEvent
 * @property {1} v
 * @property {string} id
 * @property {'crash'|'recovery'} type
 * @property {string} at ISO timestamp
 * @property {string} command the wrapped command line
 * @property {string|null} error first error line, if any
 * @property {number|null} exit
 * @property {string|null} signal
 * @property {string} [status] recovery only: fixed | unfixed | dry-run | aborted | ...
 * @property {string|null} [branch] recovery only
 * @property {string|null} [report] recovery only, relative to the repo root
 * @property {string} [message] recovery only
 * @property {string|null} [session] recovery only: Claude Code session id (`claude --resume <id>`)
 */

const EVENTS_REL = path.join('.phantom', 'events.jsonl');
const CURSOR_REL = path.join('.phantom', 'events.cursor');
const LOCK_REL = path.join('.phantom', 'events.lock');
const MAX_EVENTS = 200;
/**
 * Trim only once the log is half again over the cap. Trimming is the one
 * operation that rewrites the whole file, so it is worth making rare: between
 * trims every write is a bare append, which is where the concurrency safety
 * comes from.
 */
const TRIM_AT = Math.floor(MAX_EVENTS * 1.5);
const STALE_MS = 24 * 60 * 60 * 1000;
/**
 * Per-field caps, in characters.
 *
 * `error` is one line of the crashed program's own output, and nothing bounded
 * it: a minified bundle or a JSON blob on one line went verbatim into the log
 * and from there straight into `additionalContext` on every Claude Code prompt
 * in that repo. One 200 KB line measured 200,142 bytes of events.jsonl and
 * ~50k tokens burned out of the user's context window per event. Long enough to
 * identify the crash is all this needs to be.
 */
const MAX_ERROR_CHARS = 500;
const MAX_COMMAND_CHARS = 300;
const MAX_MESSAGE_CHARS = 500;
/** A lock older than this is assumed to belong to a process that died. */
const LOCK_STALE_MS = 10 * 1000;

let counter = 0;

function eventsPath(root) { return path.join(root, EVENTS_REL); }
function cursorPath(root) { return path.join(root, CURSOR_REL); }
function lockPath(root) { return path.join(root, LOCK_REL); }

/** One line, bounded, with the truncation visible rather than silent. */
function clamp(value, max) {
  if (typeof value !== 'string') return value;
  const oneLine = value.replace(/\s*[\r\n]+\s*/g, ' ');
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

/**
 * Exclusive lock via O_EXCL create -- atomic on POSIX and Windows alike, and
 * the only mutual exclusion available without a dependency. Returns a release
 * function, or null when the lock is held.
 */
function acquireLock(root) {
  const file = lockPath(root);
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    // Held. If the holder died mid-trim the lock would block trimming forever,
    // so break it once it is clearly stale. Worst case two trims overlap, and
    // both write a complete file via rename, so the log stays valid either way.
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age < LOCK_STALE_MS) return null;
      fs.unlinkSync(file);
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch {
      return null;
    }
  }
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
}

function newId(now = Date.now()) {
  counter = (counter + 1) % 0xffff;
  return now.toString(36) + '-' + process.pid.toString(36) + '-' + counter.toString(36);
}

/**
 * Append an event. Best-effort: never throws, returns the written event or null.
 * @param {string} root
 * @param {Partial<PhantomEvent> & { type: 'crash'|'recovery', command: string }} event
 * @param {{ now?: number }} [opts]
 * @returns {PhantomEvent|null}
 */
function appendEvent(root, event, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const full = Object.assign({ v: 1, id: newId(now), at: new Date(now).toISOString(), error: null, exit: null, signal: null }, event);
  full.error = clamp(full.error, MAX_ERROR_CHARS);
  full.command = clamp(full.command, MAX_COMMAND_CHARS);
  if (full.message !== undefined) full.message = clamp(full.message, MAX_MESSAGE_CHARS);
  try {
    fs.mkdirSync(path.dirname(eventsPath(root)), { recursive: true });
    // Append, always. This used to be read-all -> concat -> writeFileSync the
    // whole file, with no lock: two phantom-wrapped commands crashing at once
    // (a monorepo, `npm-run-all -p`, a CI matrix, two terminals) had each writer
    // read a snapshot the other was mid-truncate on and write it back as the
    // authoritative log. Measured: 6 writers x 10 events against a 200-line log
    // left 22, then 38, then 6 lines, losing 38, 22 and 54 of the 60 new events.
    // Not torn lines -- the file simply shrank.
    //
    // A lone O_APPEND write is atomic against other appenders, so nothing is
    // lost and nothing interleaves. The cap is enforced separately, below.
    fs.appendFileSync(eventsPath(root), JSON.stringify(full) + '\n');
    trimIfNeeded(root);
    return full;
  } catch {
    return null;
  }
}

/**
 * Enforce MAX_EVENTS without ever exposing a partial file.
 *
 * Rewriting in place is what made concurrent readers see an empty or truncated
 * log (~1% of reads under load, and `phantom-status` runs on every status-line
 * render). Writing a sibling and renaming is atomic, so a reader sees either
 * the old file or the new one. The lock keeps two trimmers from fighting; if it
 * cannot be had, the trim is simply skipped -- the log grows a little and the
 * next writer tries again, which is strictly better than corrupting it.
 */
function trimIfNeeded(root) {
  let lines;
  try {
    lines = readLines(root);
  } catch {
    return;
  }
  if (lines.length <= TRIM_AT) return;
  const release = acquireLock(root);
  if (!release) return;
  try {
    // Re-read under the lock: another writer may have appended since the check.
    const current = readLines(root);
    if (current.length <= MAX_EVENTS) return;
    const kept = current.slice(current.length - MAX_EVENTS);
    const tmp = eventsPath(root) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + '\n');
    fs.renameSync(tmp, eventsPath(root));
  } catch {
    /* best-effort: a failed trim leaves a valid, slightly long log */
  } finally {
    release();
  }
}

function readLines(root) {
  try {
    return fs.readFileSync(eventsPath(root), 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

/**
 * All parseable events, oldest first. Malformed lines are skipped.
 * @param {string} root
 * @returns {PhantomEvent[]}
 */
function readEvents(root) {
  const out = [];
  for (const line of readLines(root)) {
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

/**
 * Events after the acknowledged cursor that are younger than STALE_MS.
 * @param {string} root
 * @param {{ now?: number, staleMs?: number }} [opts]
 * @returns {PhantomEvent[]}
 */
function readUnread(root, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const staleMs = opts.staleMs === undefined ? STALE_MS : opts.staleMs;
  const events = readEvents(root);
  const cursor = readCursor(root);
  const idx = cursor ? events.findIndex((e) => e.id === cursor) : -1;
  return events.slice(idx + 1).filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && now - t <= staleMs;
  });
}

/**
 * Acknowledge everything currently in the log. Best-effort.
 * @param {string} root
 * @returns {boolean}
 */
function markRead(root) {
  const events = readEvents(root);
  if (!events.length) return false;
  try {
    fs.mkdirSync(path.dirname(cursorPath(root)), { recursive: true });
    // Same rename dance as the log: a reader must never catch this file empty
    // between truncate and write, because an empty cursor replays everything.
    const tmp = cursorPath(root) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, events[events.length - 1].id + '\n');
    fs.renameSync(tmp, cursorPath(root));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk up from `start` to the nearest directory that has a `.phantom/events.jsonl`.
 * @param {string} start
 * @returns {string|null}
 */
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

function commandOf(ctx) { return commandLineOf(ctx); }

/** @param {object} ctx crash context from gatherContext */
function crashEvent(ctx) {
  return { type: 'crash', command: commandOf(ctx), error: ctx.errorLine || null, exit: ctx.exitCode === undefined ? null : ctx.exitCode, signal: ctx.signal || null };
}

/**
 * @param {object} ctx crash context
 * @param {{ status: string, branch: string|null, reportPath: string|null, message: string }} final
 * @param {string} root
 */
function recoveryEvent(ctx, final, root) {
  return {
    type: 'recovery',
    command: commandOf(ctx),
    error: ctx.errorLine || null,
    exit: ctx.exitCode === undefined ? null : ctx.exitCode,
    signal: ctx.signal || null,
    status: final.status,
    branch: final.branch || null,
    report: final.reportPath ? path.relative(root, final.reportPath).replace(/\\/g, '/') : null,
    message: final.message || '',
    session: final.sessionId || null,
  };
}

/**
 * "just now", "3m ago", "2h ago".
 * @param {string} iso
 * @param {number} [now]
 */
function timeAgo(iso, now = Date.now()) {
  const ms = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

/**
 * One-line, plain-text summary shared by the hook and the status line.
 * @param {PhantomEvent} ev
 * @param {number} [now]
 */
function describeEvent(ev, now = Date.now()) {
  const when = timeAgo(ev.at, now);
  if (ev.type === 'crash') {
    const why = ev.signal ? 'died from ' + ev.signal : 'exit ' + (ev.exit === null ? '?' : ev.exit);
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

module.exports = {
  MAX_ERROR_CHARS, MAX_COMMAND_CHARS, TRIM_AT,
  EVENTS_REL, CURSOR_REL, MAX_EVENTS, STALE_MS,
  eventsPath, cursorPath, appendEvent, readEvents, readUnread, markRead, findRoot,
  crashEvent, recoveryEvent, describeEvent, timeAgo,
};
