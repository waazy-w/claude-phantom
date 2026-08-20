'use strict';

const os = require('node:os');
const path = require('node:path');
const { stripAnsi } = require('./ansi');

/** @typedef {import('./watcher').RunResult} RunResult */

const HEADER_RE = /^\s*\[?(?:[\w.$]*(?:Error|Exception)(?:\s\[[\w-]+\])?:|Uncaught\s+[\w.$]*(?:Error|Exception)\b|UnhandledPromiseRejection\w*\b|Traceback \(most recent call last\):|panic:|[Ff]atal(?: error)?:|FATAL:|thread '[^']*' panicked at|Exception in thread\s)/;
const PY_TRACEBACK_RE = /^Traceback \(most recent call last\):/;
const PY_BRIDGE_RE = /^(?:During handling of the above exception|The above exception was the direct cause)/;
const CONTINUATION_RE = /^(?:Caused by:|Suppressed:|\s*\.\.\. \d+ more|goroutine \d+ \[|note: |\[cause\]|[}\]]\s*$)/;
const STOP_RE = /^(?:Node\.js v\d|exit status \d+|npm (?:ERR!|error|warn)\b|\s*error Command failed)/;
const CARET_RE = /^\s*\^+\s*$/;
const FILE_LINE_PREAMBLE_RE = /^\S.*:\d+$/;
const MAX_BLOCK_LINES = 120;

const IGNORED_PATH_RE = /(?:^|\/)node_modules\/|^node:|^internal\/|^<anonymous>|^native$|^async\s|^\(?eval\b/;
// Lines longer than this are not stack frames (minified dumps, base64 blobs,
// progress bars) and are skipped: the path regex below backtracks
// quadratically on long runs without separators.
const MAX_SCAN_LINE = 4096;
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|cpp|cc|c|h|hpp|swift|scala|vue|svelte)$/i;

/**
 * @param {RunResult} runResult
 * @returns {boolean} true when the child failed and the user did not interrupt it
 */
function detectCrash(runResult) {
  if (!runResult || runResult.userInterrupted) return false;
  if (runResult.signal) return true;
  return runResult.exitCode !== null && runResult.exitCode !== undefined && runResult.exitCode !== 0;
}

function isIndented(line) {
  return /^[ \t]/.test(line) && line.trim() !== '';
}

function findBlockStart(lines, headerIdx) {
  const header = lines[headerIdx];
  if (!PY_TRACEBACK_RE.test(header)) {
    // Python: walk up through indented frame lines to the Traceback header.
    let k = headerIdx - 1;
    while (k >= 0) {
      const l = lines[k];
      if (PY_TRACEBACK_RE.test(l)) return k;
      if (isIndented(l) || l.trim() === '' || PY_BRIDGE_RE.test(l)) { k--; continue; }
      break;
    }
  }
  // Node: "file:line\n  code\n  ^\n\nError: ..." preamble.
  let k = headerIdx - 1;
  let blanks = 0;
  while (k >= 0 && lines[k].trim() === '' && blanks < 2) { k--; blanks++; }
  if (k >= 0 && CARET_RE.test(lines[k])) {
    for (let up = k - 1, steps = 0; up >= 0 && steps < 8; up--, steps++) {
      if (FILE_LINE_PREAMBLE_RE.test(lines[up])) return up;
    }
  }
  return headerIdx;
}

function findBlockEnd(lines, headerIdx) {
  const rust = /panicked at/.test(lines[headerIdx]);
  let inGoroutine = false;
  let end = headerIdx;
  let j = headerIdx + 1;
  while (j < lines.length && j - headerIdx < MAX_BLOCK_LINES) {
    const line = lines[j];
    const next = lines[j + 1] === undefined ? '' : lines[j + 1];
    if (STOP_RE.test(line)) break;
    if (line.trim() === '') {
      const continues = isIndented(next) || CONTINUATION_RE.test(next) || (rust && /^note: /.test(next));
      if (!continues) break;
      j++;
      continue;
    }
    if (/^goroutine \d+ \[/.test(line)) inGoroutine = true;
    const accept =
      isIndented(line) ||
      CONTINUATION_RE.test(line) ||
      (inGoroutine && /^\t/.test(next)) ||
      (rust && !HEADER_RE.test(line));
    if (!accept) break;
    end = j;
    j++;
  }
  return end;
}

function cleanErrorLine(line) {
  return line.trim().replace(/^\[/, '').replace(/[\]{]\s*$/, '').trim();
}

function stripPrefixes(p, prefixes) {
  for (const pre of prefixes) {
    if (!pre) continue;
    const norm = pre.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === norm) return '';
    if (p.startsWith(norm + '/')) return p.slice(norm.length + 1);
  }
  return p;
}

/**
 * @param {string} text
 * @param {{ cwd?: string, extraPrefixes?: string[] }} [opts]
 * @returns {string[]} unique repo-relative paths in order of appearance
 */
function extractFilePaths(text, opts = {}) {
  const prefixes = [opts.cwd, ...(opts.extraPrefixes || [])].filter(Boolean);
  const found = [];
  const seen = new Set();
  const add = (raw) => {
    if (!raw) return;
    let p = raw.replace(/^file:\/\//, '').replace(/\\/g, '/');
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    p = stripPrefixes(p, prefixes);
    while (p.startsWith('./')) p = p.slice(2);
    if (!p || IGNORED_PATH_RE.test(p)) return;
    if (prefixes.length && (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p))) return;
    if (!SOURCE_EXT_RE.test(p) && !p.includes('/')) return;
    if (seen.has(p)) return;
    seen.add(p);
    found.push(p);
  };
  const generic = /((?:file:\/\/)?(?:[A-Za-z]:)?[^\s()"'<>[\]:,]{1,1024}\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?/g;
  const python = /File "([^"]{1,1024})", line \d+/g;
  const scan = stripAnsi(text).split('\n').filter((l) => l.length <= MAX_SCAN_LINE).join('\n');
  let m;
  while ((m = python.exec(scan)) !== null) add(m[1]);
  while ((m = generic.exec(scan)) !== null) add(m[1]);
  return found;
}

/**
 * Find the last error block in captured output.
 * @param {string} text
 * @param {{ cwd?: string, extraPrefixes?: string[] }} [opts]
 * @returns {{ stackTrace: string|null, errorLine: string|null, hintFiles: string[] }}
 */
function extractStackTrace(text, opts = {}) {
  const lines = stripAnsi(text).replace(/\r\n?/g, '\n').split('\n');
  let headerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADER_RE.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    return { stackTrace: null, errorLine: null, hintFiles: extractFilePaths(text, opts).slice(0, 10) };
  }
  const start = findBlockStart(lines, headerIdx);
  const end = findBlockEnd(lines, headerIdx);
  const block = lines.slice(start, end + 1);
  while (block.length && block[block.length - 1].trim() === '') block.pop();
  const stackTrace = block.join('\n');
  let errorLine = cleanErrorLine(lines[headerIdx]);
  const after = lines[headerIdx + 1];
  if (/panicked at/.test(errorLine) && after && after.trim() && !isIndented(after)) {
    errorLine = errorLine.replace(/:$/, '') + ': ' + after.trim();
  }
  return { stackTrace, errorLine, hintFiles: extractFilePaths(stackTrace, opts) };
}

/**
 * @param {string|null|undefined} errorLine
 * @param {Partial<RunResult>} [runResult] used for the fallback slug
 * @returns {string} lowercase a-z0-9- slug, at most 32 characters
 */
function slugify(errorLine, runResult) {
  let slug = String(errorLine || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 32) {
    const endsOnWord = slug[32] !== '-';
    slug = slug.slice(0, 32);
    const cut = slug.lastIndexOf('-');
    if (endsOnWord && cut > 16) slug = slug.slice(0, cut);
    slug = slug.replace(/-+$/, '');
  }
  if (slug) return slug;
  if (runResult && runResult.signal) return 'signal-' + String(runResult.signal).toLowerCase();
  if (runResult && runResult.exitCode !== null && runResult.exitCode !== undefined) return 'exit-' + runResult.exitCode;
  return 'crash';
}

/**
 * @param {Partial<RunResult>} runResult
 * @returns {string} e.g. "exit code 1" or "killed by SIGSEGV"
 */
function summarizeExit(runResult) {
  if (runResult.signal) {
    const num = os.constants.signals[runResult.signal];
    return 'killed by ' + runResult.signal + (num ? ' (' + num + ')' : '');
  }
  if (runResult.exitCode === null || runResult.exitCode === undefined) return 'unknown exit';
  return 'exit code ' + runResult.exitCode;
}

module.exports = { detectCrash, extractStackTrace, extractFilePaths, slugify, summarizeExit, HEADER_RE };
