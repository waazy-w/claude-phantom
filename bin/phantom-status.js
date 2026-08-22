#!/usr/bin/env node
'use strict';

/**
 * Claude Code status-line segment for phantom.
 *
 * Reads the status-line JSON on stdin (uses `workspace.current_dir`, then
 * `cwd`, then process.cwd()), finds the nearest `.phantom/events.jsonl`, and
 * prints ONE line describing the most recent unread event, or nothing.
 *
 *   phantom-status              print the segment (meant for settings.json statusLine)
 *   phantom-status --mark-read  acknowledge all events, print nothing
 *   phantom-status --help
 *
 * Never throws and never exits non-zero; on any error it prints nothing.
 * Colours are disabled when NO_COLOR is set (https://no-color.org).
 */

const events = require('../src/events');

const FIXING_MS = 20 * 60 * 1000;
const CMD_MAX = 40;
const STDIN_TIMEOUT_MS = 2000;

const GREEN = 32;
const YELLOW = 33;
const CYAN = 36;
const RED = 31;

const HELP = [
  'Usage: phantom-status [--mark-read] [--help]',
  '',
  'Claude Code status-line segment. Reads the status-line JSON on stdin and prints',
  'one line about the most recent unread phantom event (or nothing).',
  '',
  'Add to ~/.claude/settings.json:',
  '  "statusLine": { "type": "command", "command": "phantom-status" }',
  '',
  '  --mark-read   acknowledge all events in the current repo, print nothing',
  '  --help        show this help',
  '',
  'Set NO_COLOR to disable ANSI colours.',
].join('\n');

function useColor() {
  return !(process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '');
}

function paint(code, text, color = useColor()) {
  return color ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
}

function shortCmd(command) {
  const c = String(command || '');
  return c.length > CMD_MAX ? c.slice(0, CMD_MAX - 1) + '…' : c;
}

/**
 * Render the segment for a list of unread events (oldest first).
 * @param {object[]} unread
 * @param {number} now
 * @param {boolean} [color]
 * @returns {string} '' when there is nothing to show
 */
function render(unread, now, color = useColor()) {
  if (!unread || !unread.length) return '';
  const last = unread[unread.length - 1];
  const cmd = shortCmd(last.command);
  let text;
  let code;
  if (last.type === 'recovery') {
    if (last.status === 'fixed') { text = 'fixed ' + cmd + (last.branch ? ' → ' + last.branch : ''); code = GREEN; }
    else if (last.status === 'unfixed') { text = 'could not fix ' + cmd; code = YELLOW; }
    else if (last.status === 'dry-run') { text = 'dry run: ' + cmd; code = CYAN; }
    else { text = (last.status || 'recovery') + ': ' + cmd; code = YELLOW; }
  } else {
    const age = now - Date.parse(last.at);
    if (Number.isFinite(age) && age < FIXING_MS) { text = 'fixing ' + cmd + '…'; code = YELLOW; }
    else { text = cmd + ' crashed ' + events.timeAgo(last.at, now); code = RED; }
  }
  const extra = unread.length > 1 ? ' (+' + (unread.length - 1) + ')' : '';
  return paint(GREEN, '👻', color) + ' ' + paint(code, text, color) + extra;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    // Release stdin as well as resolving. process.exit(0) used to cover for a
    // still-referenced stdin handle keeping the event loop alive; dropping the
    // handle here is what lets the process end on its own, which is what makes
    // the flush below safe.
    const done = () => {
      if (settled) return;
      settled = true;
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

function startDir(input) {
  const ws = input && input.workspace && typeof input.workspace === 'object' ? input.workspace : {};
  if (typeof ws.current_dir === 'string' && ws.current_dir) return ws.current_dir;
  if (input && typeof input.cwd === 'string' && input.cwd) return input.cwd;
  return process.cwd();
}

/**
 * Write to stdout and wait for the bytes to actually leave.
 *
 * Claude Code reads the status line through a pipe, and writes to a pipe are
 * asynchronous on Windows (and past the ~64 KiB buffer everywhere). Calling
 * process.exit() straight after a write discards whatever libuv still has
 * queued -- silently, with no error -- so the segment simply never appears.
 * This is the same defect already fixed in plugin/hooks/phantom-events.js;
 * this binary never got the same treatment.
 */
function write(text) {
  return new Promise((resolve) => { process.stdout.write(text, () => resolve()); });
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    await write(HELP + '\n');
    return;
  }
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
  const root = events.findRoot(startDir(input));
  if (!root) return;
  if (argv.includes('--mark-read')) {
    events.markRead(root);
    return;
  }
  const now = Date.now();
  const line = render(events.readUnread(root, { now }), now);
  if (line) await write(line + '\n');
}

if (require.main === module) {
  main(process.argv.slice(2))
    .catch(() => { /* print nothing on error */ })
    .then(() => { process.exitCode = 0; });
}

module.exports = { render, shortCmd, startDir, FIXING_MS, CMD_MAX };
