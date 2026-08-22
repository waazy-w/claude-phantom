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
const MAX_EVENTS = 200;
const STALE_MS = 24 * 60 * 60 * 1000;

let counter = 0;

function eventsPath(root) { return path.join(root, EVENTS_REL); }
function cursorPath(root) { return path.join(root, CURSOR_REL); }

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
  try {
    fs.mkdirSync(path.dirname(eventsPath(root)), { recursive: true });
    const existing = readLines(root);
    const lines = existing.concat(JSON.stringify(full));
    const kept = lines.length > MAX_EVENTS ? lines.slice(lines.length - MAX_EVENTS) : lines;
    if (kept.length === lines.length && existing.length) {
      fs.appendFileSync(eventsPath(root), JSON.stringify(full) + '\n');
    } else {
      fs.writeFileSync(eventsPath(root), kept.join('\n') + '\n');
    }
    return full;
  } catch {
    return null;
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
    fs.writeFileSync(cursorPath(root), events[events.length - 1].id + '\n');
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
  EVENTS_REL, CURSOR_REL, MAX_EVENTS, STALE_MS,
  eventsPath, cursorPath, appendEvent, readEvents, readUnread, markRead, findRoot,
  crashEvent, recoveryEvent, describeEvent, timeAgo,
};
