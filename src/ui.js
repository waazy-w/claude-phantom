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

/**
 * Terminal COLUMNS a string occupies, not UTF-16 code units.
 *
 * The two differ in both directions and the banner is built out of exactly the
 * characters where they differ: ✅ ❌ ⚠ 🔍 👻 are one or two code units but two
 * columns each, so `.length` under-counted and the box's right border landed
 * short -- on the success banner, which is the one users see most. Astral
 * characters (👻) are also two code units for one character, so a naive
 * `.length` is wrong twice over.
 *
 * This is a pragmatic width table, not a full UAX #11 implementation: the wide
 * ranges phantom actually prints, plus zero-width combining marks and variation
 * selectors, which otherwise each added a phantom column.
 */
function charWidth(cp) {
  // Combining marks, zero-width joiners/spaces, variation selectors.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  // East Asian Wide / Fullwidth, and the emoji planes.
  if (cp >= 0x1100 && (
    (cp <= 0x115f)                              // Hangul Jamo
    || cp === 0x2329 || cp === 0x232a
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)  // CJK
    || (cp >= 0xac00 && cp <= 0xd7a3)           // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfaff)           // CJK compatibility
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)           // Fullwidth forms
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)         // emoji, incl. 👻 🔍
    || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  )) return 2;
  // Symbols that render double-width in practice: ✅ ❌ ⚠ and friends.
  if (cp === 0x2705 || cp === 0x274c || cp === 0x274e) return 2;
  if (cp >= 0x2b00 && cp <= 0x2bff) return 2;
  return 1;
}

const visibleLength = (s) => {
  let width = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) width += charWidth(ch.codePointAt(0));
  return width;
};

/** Split `s` after `width` display columns, ANSI-aware. */
function sliceColumns(s, width) {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * Wrap `line` to `width` display columns.
 *
 * Splitting on spaces alone left any single token longer than `width` on its
 * own over-long row, and banner() then sized the box to that row -- so a long
 * report path drew a border WIDER than the terminal, which the terminal then
 * wrapped into garbage. Hard-breaking an unbreakable token is the floor that
 * keeps the box inside its own bounds no matter what a caller passes.
 */
function wrap(line, width) {
  if (visibleLength(line) <= width) return [line];
  const out = [];
  let cur = '';
  const push = (chunk) => {
    let rest = chunk;
    while (visibleLength(rest) > width) {
      out.push(sliceColumns(rest, width));
      rest = rest.slice(sliceColumns(rest, width).length);
    }
    cur = rest;
  };
  for (const w of line.split(' ')) {
    if (visibleLength(w) > width) { if (cur) { out.push(cur); cur = ''; } push(w); continue; }
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
  // Clamped, not just measured. Sizing to the widest row let one over-long
  // token draw a box wider than the terminal.
  const width = Math.min(maxWidth, rows.reduce((w, l) => Math.max(w, visibleLength(l)), 0));
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

module.exports = { colors, banner, log, spinner, ask, openTerminal, setStream, colorsEnabled, visibleLength, charWidth, wrap, sliceColumns };
