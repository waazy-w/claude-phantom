'use strict';

/**
 * All phantom output goes to stderr. stdout belongs to the wrapped command.
 */

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
  stream.write(colors.dim('phantom ›') + ' ' + line + '\n');
}

const log = {
  info: (msg) => write(String(msg)),
  warn: (msg) => write(colors.yellow(String(msg))),
  error: (msg) => write(colors.red(String(msg))),
  verbose: (msg) => { if (verbose) write(colors.dim(String(msg))); },
  setVerbose: (on) => { verbose = Boolean(on); },
  isVerbose: () => verbose,
};

/** Test hook: redirect phantom's own output (defaults back to stderr). */
function setStream(s) {
  stream = s || process.stderr;
}

module.exports = { colors, banner, log, setStream, colorsEnabled, visibleLength };
