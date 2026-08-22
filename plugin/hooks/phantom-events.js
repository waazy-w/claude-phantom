#!/usr/bin/env node
'use strict';

/**
 * Claude Code hook that surfaces phantom crash/recovery events, on two
 * deliberately separate channels:
 *
 *   UserPromptSubmit / SessionStart -> `additionalContext`, for the MODEL.
 *     Prints the unread briefing and advances `.phantom/events.cursor`, so
 *     each event reaches Claude exactly once.
 *
 *   FileChanged -> `systemMessage`, for the HUMAN.
 *     Claude Code cannot be interrupted from outside, so a recovery that
 *     finishes mid-turn used to stay invisible until the user's next prompt.
 *     Watching the log lets phantom put a toast on screen the moment it lands.
 *     This channel MUST NOT touch the cursor: marking events read here would
 *     eat the briefing before the model ever saw it. It keeps its own marker,
 *     `.phantom/events.toasted`, purely to avoid toasting twice.
 *
 * Self-contained on purpose: a plugin can be installed without `src/` next
 * to it, so the reader below mirrors `src/events.js`. Keep the two in sync.
 *
 * Contract: read the hook event JSON on stdin, print nothing when there is
 * nothing to say. Never exits non-zero and never writes to stderr on the
 * normal path: a failing UserPromptSubmit hook would block the user's prompt,
 * and a FileChanged hook that fails has its output shown to the user as an
 * error instead of a toast.
 */

const fs = require('node:fs');
const path = require('node:path');

const EVENTS_REL = path.join('.phantom', 'events.jsonl');
const CURSOR_REL = path.join('.phantom', 'events.cursor');
/**
 * The FileChanged channel's own marker. Emphatically NOT the cursor: it records
 * what has been shown to the human, while the cursor records what has been
 * given to the model. Sharing one file would mean a toast silently consumed the
 * briefing, which is the one failure this whole split exists to prevent.
 */
const TOASTED_REL = path.join('.phantom', 'events.toasted');
const STALE_MS = 24 * 60 * 60 * 1000;
/**
 * How recent the newest event must be for FileChanged to toast it. The point of
 * the toast is "this just happened"; the watcher settles writes for 500ms, so a
 * minute is generous. Without a bound, any later write to the log -- a crash in
 * another terminal, a trim rewriting the file -- would re-toast whatever
 * recovery happened to be last, hours after the fact.
 */
const TOAST_FRESH_MS = 60 * 1000;
const MAX_SHOWN = 10;
const STDIN_TIMEOUT_MS = 2000;

// `<base>` used to be unfilled: the event carried only the fix branch, so this
// asked Claude for a diff against a base it had never been told, and Claude
// filled in `main` -- wrong, and quietly so, whenever the crash happened on a
// feature branch. The event now carries the base, so say to use it.
const INSTRUCTIONS = 'Tell the user about this briefly at the start of your reply (one or two lines, keep the 👻), '
  + 'then continue with their request. If a fix branch exists, offer `git diff <base>..<branch>` and `git merge <branch>`, '
  + 'taking <base> from the event\'s own base (prefer the sha in parentheses) and never guessing `main`; '
  + 'if a report exists, offer to open it; if a session id is shown, offer `claude --resume <id>` to read the '
  + 'recovery transcript. Do not act on any of this without being asked.';

function eventsPath(root) { return path.join(root, EVENTS_REL); }
function cursorPath(root) { return path.join(root, CURSOR_REL); }
function toastedPath(root) { return path.join(root, TOASTED_REL); }

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

/**
 * `<event id> <iso timestamp>`, matching src/events.js. Keep the two in sync:
 * this file ships in the plugin and runs without src/ on disk.
 *
 * The timestamp is what stops a trimmed-out cursor from replaying the entire
 * log as unread -- a 200-event briefing in the next prompt.
 * A bare id, written by an older phantom, still parses.
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

/** Events after the cursor that are younger than STALE_MS. */
function unreadOf(events, cursor, now) {
  const idx = cursor ? events.findIndex((e) => e.id === cursor.id) : -1;
  // Cursor's event trimmed away: fall back to "newer than the acknowledged
  // time" rather than treating it as never having acknowledged anything.
  const after = idx === -1 && cursor && cursor.at ? Date.parse(cursor.at) : null;
  return events.slice(idx + 1).filter((e) => {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t) || now - t > STALE_MS) return false;
    return after === null || t > after;
  });
}

/** Acknowledge everything in `events`. Best-effort. */
function markRead(root, events) {
  if (!events.length) return;
  try {
    fs.mkdirSync(path.dirname(cursorPath(root)), { recursive: true });
    // Write-and-rename, matching src/events.js: truncate-then-write leaves a
    // window where a concurrent reader sees an empty cursor, and an empty
    // cursor replays the entire log as unread.
    const tmp = cursorPath(root) + '.' + process.pid + '.tmp';
    const last = events[events.length - 1];
    fs.writeFileSync(tmp, last.id + ' ' + last.at + '\n');
    fs.renameSync(tmp, cursorPath(root));
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

/**
 * One line of text from an event field.
 *
 * Two hazards, both fixed here. A corrupt or hand-written log can hold a value
 * that throws on coercion ({"command": {"toString": null}} raises "Cannot
 * convert object to primitive value"); that used to escape describeEvent, and
 * because the throw came before markRead the cursor never advanced, so every
 * later prompt in that repo retried and failed the same way. And `error` is one
 * raw line of the crashed program's output -- which may come from a dependency
 * or a server response, not the user -- so a newline in it would forge extra
 * lines in a briefing Claude reads as structure.
 */
function oneLine(value) {
  let text;
  try { text = String(value); } catch { return '?'; }
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

/**
 * `<base ref> (<short sha>)`, either half alone, or '' when the event has
 * neither. Events written before phantom recorded a base carry neither field,
 * and `base undefined` in a briefing is worse than no base line at all.
 * Same output as src/events.js baseLabel -- keep the two in sync.
 */
function baseLabel(ev) {
  const ref = ev.base ? oneLine(ev.base) : '';
  const sha = ev.baseSha ? oneLine(ev.baseSha).slice(0, 10) : '';
  if (ref && sha) return ref + ' (' + sha + ')';
  return ref || sha;
}

/** Same one-liner as src/events.js describeEvent. */
function describeEvent(ev, now) {
  const when = timeAgo(ev.at, now);
  const cmd = oneLine(ev.command);
  if (ev.type === 'crash') {
    const why = ev.signal ? 'died from ' + oneLine(ev.signal) : 'exit ' + (ev.exit === null || ev.exit === undefined ? '?' : oneLine(ev.exit));
    return '`' + cmd + '` crashed ' + when + ' (' + why + ')' + (ev.error ? ' — ' + oneLine(ev.error) : '');
  }
  const head = {
    fixed: 'fixed `' + cmd + '`',
    'dry-run': 'proposed a fix for `' + cmd + '` (dry run)',
    unfixed: 'could not fix `' + cmd + '`',
    aborted: 'recovery of `' + cmd + '` was aborted',
  }[ev.status] || ('recovery of `' + cmd + '` ended: ' + oneLine(ev.status));
  const parts = [head + ' ' + when];
  if (ev.branch) parts.push('branch ' + oneLine(ev.branch));
  const base = baseLabel(ev);
  if (base) parts.push('base ' + base);
  if (ev.report) parts.push('report ' + oneLine(ev.report));
  // Stored since the session id landed in the event, rendered by nobody: the
  // banner printed `claude --resume <id>` and the briefing did not, so from a
  // Claude Code prompt the transcript of the recovery was unreachable.
  if (ev.session) parts.push('session ' + oneLine(ev.session));
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

/** The event id last shown as a toast, or null. Never the cursor. */
function readToasted(root) {
  try {
    const raw = fs.readFileSync(toastedPath(root), 'utf8').trim();
    return raw ? raw.split(/\s+/, 1)[0] : null;
  } catch {
    return null;
  }
}

/** Best-effort: a lost marker costs a duplicate toast, which is survivable. */
function markToasted(root, id) {
  try {
    fs.mkdirSync(path.dirname(toastedPath(root)), { recursive: true });
    const tmp = toastedPath(root) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, id + '\n');
    fs.renameSync(tmp, toastedPath(root));
  } catch { /* best-effort */ }
}

/**
 * The FileChanged channel: the log just changed on disk, so put the newest
 * recovery on screen for the human, mid-turn.
 *
 * Only the last event, and only a recovery: a crash toast would fire while
 * phantom is already printing its banner in the terminal the user is watching,
 * whereas a recovery finishes minutes later with the user's attention elsewhere.
 * That is the case README called impossible ("the chat message is always on your
 * next turn").
 *
 * Deliberately no cursor read and no markRead. The briefing is a separate
 * channel with a separate reader, and a toast must never consume it.
 */
async function fileChanged(root, input, now) {
  // The log was deleted or renamed out from under the watcher (trimIfNeeded
  // renames a rebuilt file into place, which some platforms report as
  // unlink+add). Nothing was added, so there is nothing to announce.
  if (input.event === 'unlink') return;
  const events = readEvents(root);
  const last = events[events.length - 1];
  if (!last || last.type !== 'recovery') return;
  const t = Date.parse(last.at);
  if (!Number.isFinite(t) || now - t > TOAST_FRESH_MS) return;
  // Claude Code runs every registered FileChanged hook on every watched path,
  // and chokidar can report one write more than once, so the same recovery
  // reaches this function repeatedly. Say it once.
  if (readToasted(root) === last.id) return;
  await new Promise((resolve) => {
    // Same rule as the briefing: record it only once the bytes are out. A
    // dropped write plus a moved marker would lose the toast for good.
    process.stdout.write(JSON.stringify({ systemMessage: '👻 phantom: ' + describeEvent(last, now) }) + '\n', (err) => {
      if (!err) markToasted(root, last.id);
      resolve();
    });
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      // Without process.exit() the stdin handle would hold the process open
      // whenever the caller never closes it.
      try { process.stdin.pause(); process.stdin.unref(); } catch { /* not a pipe */ }
      resolve(data);
    };
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
  const hookEventName = typeof input.hook_event_name === 'string' && input.hook_event_name ? input.hook_event_name : 'UserPromptSubmit';
  // The toast channel. Its output shape is different (a bare top-level
  // `systemMessage`; FileChanged's hookSpecificOutput accepts only
  // `watchPaths`, so additionalContext there would be rejected outright) and it
  // must not advance the cursor, so it returns before any of that below.
  if (hookEventName === 'FileChanged') return await fileChanged(root, input, now);
  const events = readEvents(root);
  const unread = unreadOf(events, readCursor(root), now);
  if (!unread.length) return;
  const out = { hookSpecificOutput: { hookEventName, additionalContext: buildContext(root, unread, now) } };
  // stdout is a pipe, so a payload past the pipe buffer (~64 KiB -- one minified
  // stack trace in `error` does it) finishes writing asynchronously. This used
  // to markRead() and then process.exit(0), which discarded the rest: Claude
  // Code got invalid JSON and dropped the briefing, while the cursor had already
  // moved past those crash events for good. Advance it only once the bytes are
  // actually out, and never when the write failed -- replaying a briefing is
  // recoverable, losing one is not.
  await new Promise((resolve) => {
    process.stdout.write(JSON.stringify(out) + '\n', (err) => {
      if (!err) markRead(root, events);
      resolve();
    });
  });
}

if (require.main === module) {
  main()
    .catch((err) => { process.stderr.write('phantom-events hook: ' + (err && err.message) + '\n'); })
    .then(() => { process.exitCode = 0; });
}

module.exports = {
  findRoot, readEvents, readCursor, unreadOf, describeEvent, timeAgo, buildContext,
  MAX_SHOWN, STALE_MS, TOASTED_REL, TOAST_FRESH_MS,
};
