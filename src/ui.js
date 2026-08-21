'use strict';

/**
 * All phantom output goes to stderr. stdout belongs to the wrapped command.
 */

const fs = require('node:fs');
const tty = require('node:tty');

const ESC = '\u001b';
let stream = process.stderr;
let verbose = false;

function colorsEnabled() {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY);
}

function paint(open, close) {
  return (s) => (colorsEnabled() ? ESC + '[' + open + 'm' + s + ESC + '[' + close + 'm' : String(s));
}

const colors = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  cyan: paint(36, 39),
  magenta: paint(35, 39),
};

const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const visibleLength = (s) => String(s).replace(ANSI_RE, '').length;

function wrap(line, width) {
  if (visibleLength(line) <= width) return [line];
  const out = [];
  let cur = '';
  for (const w of line.split(' ')) {
    if (cur && visibleLength(cur) + 1 + visibleLength(w) > width) { out.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Print a box-drawn banner to stderr.
 * @param {string|string[]} lines
 * @param {{ color?: (s: string) => string }} [opts] color applied to the frame
 */
function banner(lines, opts = {}) {
  const frame = opts.color || colors.cyan;
  const cols = stream.columns || 80;
  const maxWidth = Math.max(20, Math.min(cols - 4, 100));
  const rows = (Array.isArray(lines) ? lines : String(lines).split('\n')).flatMap((l) => wrap(l, maxWidth));
  const width = rows.reduce((w, l) => Math.max(w, visibleLength(l)), 0);
  const pad = (l) => l + ' '.repeat(width - visibleLength(l));
  const out = [
    frame('╭' + '─'.repeat(width + 2) + '╮'),
    ...rows.map((l) => frame('│') + ' ' + pad(l) + ' ' + frame('│')),
    frame('╰' + '─'.repeat(width + 2) + '╯'),
  ];
  stream.write(out.join('\n') + '\n');
}

function write(line) {
  if (live) stream.write(CLEAR_LINE);
  stream.write(colors.dim('phantom ›') + ' ' + line + '\n');
  if (live) live.render();
}

const CLEAR_LINE = '\r' + ESC + '[2K';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The spinner currently painting the last line of stderr, if any. */
let live = null;

// Zero-padded so a ticking clock does not jitter in width as it counts.
function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return total + 's';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return minutes + 'm ' + String(total % 60).padStart(2, '0') + 's';
  return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
}

/**
 * An animated status line for phases that are slow and silent -- the Claude
 * session mainly, which can sit for minutes with nothing to print. The elapsed
 * counter is the point: it is the difference between "this is working" and
 * "this has hung".
 *
 * Only animates on a TTY. In a pipe, a CI log, or under --verbose (where the
 * session streams its own output to stderr) a redrawn line is noise or a
 * collision, so the spinner goes silent and the static log line that precedes
 * it carries the message on its own.
 *
 * @param {string} text
 * @param {{ enabled?: boolean, intervalMs?: number, now?: () => number }} [opts]
 */
function spinner(text, opts = {}) {
  const now = opts.now || Date.now;
  const started = now();
  const enabled = opts.enabled === undefined ? Boolean(stream.isTTY) : Boolean(opts.enabled);
  let label = String(text);
  let frame = 0;
  let stopped = false;
  let timer = null;

  const api = {
    render() {
      if (!enabled || stopped) return;
      stream.write(CLEAR_LINE + colors.dim('phantom ›') + ' ' + colors.cyan(FRAMES[frame % FRAMES.length])
        + ' ' + label + ' ' + colors.dim(formatElapsed(now() - started)));
    },
    tick() { frame += 1; api.render(); },
    update(next) { label = String(next); api.render(); },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (live === api) live = null;
      if (enabled) stream.write(CLEAR_LINE);
    },
  };

  if (enabled) {
    live = api;
    api.render();
    timer = setInterval(api.tick, Math.max(1, opts.intervalMs || 120));
    // Never let the animation be the reason the process stays alive.
    if (timer.unref) timer.unref();
  }
  return api;
}

const log = {
  info: (msg) => write(String(msg)),
  warn: (msg) => write(colors.yellow(String(msg))),
  error: (msg) => write(colors.red(String(msg))),
  verbose: (msg) => { if (verbose) write(colors.dim(String(msg))); },
  setVerbose: (on) => { verbose = Boolean(on); },
  isVerbose: () => verbose,
};

/**
 * Where to read the answer from.
 *
 * Not process.stdin: the recovery session is a long-lived child that takes the
 * controlling terminal for itself, and once it exits the inherited stdin no
 * longer delivers a line -- readline sees end-of-input and closes, so the
 * prompt printed and vanished without waiting. /dev/tty is a fresh handle on
 * the same terminal and is unaffected by whatever the child did. Falling back
 * to stdin covers Windows, which has no /dev/tty, and any session with no
 * controlling terminal.
 * @returns {{ input: NodeJS.ReadableStream, close: () => void }}
 */
function openTerminal() {
  let fd = null;
  try {
    fd = fs.openSync('/dev/tty', 'r');
    // tty.ReadStream, not fs.createReadStream: readline needs setRawMode to turn
    // off the terminal driver's own echo while it does its own. A plain file
    // stream cannot, so both echo and every keystroke appears twice.
    const input = new tty.ReadStream(fd);
    return { input, close: () => { try { input.destroy(); } catch { /* already closed */ } } };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    return { input: process.stdin, close: () => {} };
  }
}

/**
 * Ask a single-letter question on stderr and read one line from stdin.
 *
 * Resolves to null -- "no answer, change nothing" -- whenever an answer cannot
 * be had: a non-interactive session, end of input, Ctrl+C, or the timeout.
 * Every caller must treat null as "leave everything alone", because phantom
 * wraps commands that people run in scripts and CI, and a wrapper that blocks
 * forever waiting on a human is worse than one that never asks.
 *
 * @param {string} question
 * @param {{ keys: string[], input?: NodeJS.ReadStream, enabled?: boolean, timeoutMs?: number, attempts?: number }} opts
 * @returns {Promise<string|null>} one of `keys`, lowercased, or null
 */
function ask(question, opts) {
  const keys = opts.keys.map((k) => String(k).toLowerCase());
  // Decide interactivity from the real descriptors, before choosing what to read
  // from: a piped stdin means a script or CI, and must never see a prompt --
  // even though the controlling terminal below would happily supply one.
  const enabled = opts.enabled === undefined
    ? Boolean(process.stdin.isTTY && stream.isTTY)
    : Boolean(opts.enabled);
  if (!enabled) return Promise.resolve(null);

  const { input, close } = opts.input ? { input: opts.input, close: () => {} } : openTerminal();
  const readline = require('node:readline');
  const timeoutMs = opts.timeoutMs === undefined ? 120000 : opts.timeoutMs;
  let attemptsLeft = Math.max(1, opts.attempts === undefined ? 3 : opts.attempts);

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output: stream, terminal: Boolean(input.isTTY) });
    let settled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => finish(null), timeoutMs) : null;

    function finish(answer) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      // readline leaves the stream flowing; without this phantom would not exit.
      if (input.pause) input.pause();
      close();
      resolve(answer);
    }

    function turn() {
      rl.question(colors.dim('phantom ›') + ' ' + question + ' ', (raw) => {
        const answer = String(raw).trim().toLowerCase();
        const hit = keys.find((k) => answer === k || answer === k + '\n');
        if (hit) return finish(hit);
        attemptsLeft -= 1;
        if (attemptsLeft <= 0) return finish(null);
        write(colors.yellow('please answer with one of: ' + keys.join(', ')));
        turn();
      });
    }

    rl.on('close', () => finish(null));
    rl.on('SIGINT', () => finish(null));
    turn();
  });
}

/** Test hook: redirect phantom's own output (defaults back to stderr). */
function setStream(s) {
  if (live) live.stop();
  stream = s || process.stderr;
}

module.exports = { colors, banner, log, spinner, ask, openTerminal, setStream, colorsEnabled, visibleLength };
