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
 * @property {string|null} [branch] recovery only: the phantom/fix-* branch
 * @property {string|null} [base] recovery only: the ref the fix was cut from
 * @property {string|null} [baseSha] recovery only: the commit the fix was cut from
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
    // Heal a torn tail first. appendFileSync concatenates onto whatever is
    // already there, so a file whose last line lost its newline -- a writer
    // killed mid-write, a full disk -- merged the next event into the broken
    // one and BOTH were then unparseable. The crash simply never reached Claude
    // or the status line, and the log did not self-heal until the next trim.
    if (endsMidLine(root)) fs.appendFileSync(eventsPath(root), '\n');
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

/** Does the log end without a newline? Only the last byte is read. */
function endsMidLine(root) {
  let fd;
  try {
    const file = eventsPath(root);
    const size = fs.statSync(file).size;
    if (!size) return false;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
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

/**
 * The acknowledged position: `<event id>` and the timestamp it carried.
 *
 * The timestamp is the whole point. The cursor used to be a bare id, and
 * `findIndex` returning -1 was treated identically to "never acknowledged
 * anything" -- so once the cursor's own event was trimmed out of the log (200
 * events later, or after any of the writes that used to be lost), every event
 * in the file was unread again: a 200-event briefing dumped into the next
 * prompt and `(+199)` on the status line. Falling back to "newer than the
 * acknowledged time" degrades gracefully instead.
 *
 * Written as `<id> <iso>`; a bare id from an older phantom still parses.
 * @returns {{ id: string, at: string|null }|null}
 */
function readCursor(root) {
  try {
    const raw = fs.readFileSync(cursorPath(root), 'utf8').trim();
    if (!raw) return null;
    const [id, at] = raw.split(/\s+/, 2);
    return { id, at: at && Number.isFinite(Date.parse(at)) ? at : null };
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
  const idx = cursor ? events.findIndex((e) => e.id === cursor.id) : -1;
  // The cursor's event is gone but we know when it was: treat everything at or
  // before that moment as already seen, rather than replaying the whole log.
  const after = idx === -1 && cursor && cursor.at ? Date.parse(cursor.at) : null;
  return events.slice(idx + 1).filter((e) => {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || now - t > staleMs) return false;
    return after === null || t > after;
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
    const last = events[events.length - 1];
    fs.writeFileSync(tmp, last.id + ' ' + last.at + '\n');
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
 * @param {{ status: string, branch: string|null, base?: string|null, baseSha?: string|null,
 *           reportPath: string|null, message: string, sessionId?: string|null }} final
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
    // Where the fix branch was cut from. Without it the briefing named only the
    // fix branch, so Claude was told to offer `git diff <base>..<branch>` with
    // nothing to put in <base> and filled in `main` -- wrong every time the
    // crash happened on a feature branch, and silently wrong: the diff runs and
    // shows the feature branch's whole history as if phantom had written it.
    //
    // The branch half is derivable here: recovery.js builds its own `origRef`
    // out of exactly these two ctx.git fields. The sha half is not -- recovery
    // takes it with `git rev-parse HEAD` at branch time, and `phantom recover`
    // replays captures that can be days old, so ctx.git.headSha is the sha at
    // *capture* time and may be nowhere near the branch point. Prefer what
    // recovery.js passes; never invent a sha from a stale snapshot.
    base: final.base || (ctx.git && !ctx.git.detached ? ctx.git.branch : null) || null,
    baseSha: final.baseSha || null,
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
 * `<base ref> (<short sha>)`, either half alone, or '' when the event has
 * neither. Events written before phantom recorded a base carry neither field,
 * and `base undefined` in a briefing is worse than no base line at all.
 *
 * The sha is shortened to 10 like the report table and the undo hint, so the
 * same commit reads the same wherever the user meets it.
 * @param {PhantomEvent} ev
 */
function baseLabel(ev) {
  const ref = ev.base ? ev.base : '';
  const sha = ev.baseSha ? String(ev.baseSha).slice(0, 10) : '';
  if (ref && sha) return ref + ' (' + sha + ')';
  return ref || sha;
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
  const base = baseLabel(ev);
  if (base) parts.push('base ' + base);
  if (ev.report) parts.push('report ' + ev.report);
  // Stored since the session id landed in the event, rendered by nobody: the
  // banner printed `claude --resume <id>` and the briefing did not, so from a
  // Claude Code prompt the transcript of the recovery was unreachable.
  if (ev.session) parts.push('session ' + ev.session);
  return parts.join(' · ');
}

module.exports = {
  MAX_ERROR_CHARS, endsMidLine, MAX_COMMAND_CHARS, TRIM_AT,
  EVENTS_REL, CURSOR_REL, MAX_EVENTS, STALE_MS,
  eventsPath, cursorPath, appendEvent, readEvents, readUnread, markRead, findRoot,
  crashEvent, recoveryEvent, describeEvent, timeAgo,
};
