'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { summarizeExit } = require('./crash');

const VERIFICATION_MARKER = '<!-- phantom:verification -->';
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'post-mortem.md');

const STATUS_BADGES = {
  fixed: '✅ FIXED',
  'dry-run': '🔍 DRY RUN',
  refused: '⚠️ PARTIAL',
  aborted: '⚠️ PARTIAL',
  unfixed: '❌ UNFIXED',
  timeout: '❌ UNFIXED',
  error: '❌ UNFIXED',
};

/** @returns {string} the shipped post-mortem template */
function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

/**
 * Substitute `{{name}}` placeholders. Unknown placeholders are left intact so
 * Claude can fill them later; null/undefined known values become "".
 * @param {string} template
 * @param {Record<string, unknown>} vars
 * @returns {string}
 */
function renderTemplate(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return m;
    const v = vars[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

/**
 * Keep the last `n` lines, prefixing a note when something was cut.
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
function trimLines(text, n) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length <= n) return lines.join('\n');
  const cut = lines.length - n;
  return '… (' + cut + ' lines trimmed)\n' + lines.slice(cut).join('\n');
}

/**
 * Keep the last `maxBytes` bytes (on a UTF-8 boundary), prefixing a note.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function trimBytes(text, maxBytes) {
  const buf = Buffer.from(String(text || ''), 'utf8');
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  const kept = buf.subarray(start).toString('utf8');
  return '… (' + (buf.length - maxBytes) + ' bytes trimmed)\n' + kept.replace(/^[^\n]*\n/, '');
}

function statusBadge(status) {
  return STATUS_BADGES[status] || '❌ UNFIXED';
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return m + 'm ' + rest + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

/**
 * Recovery spend, in tokens rather than dollars. A dollar figure reads as what
 * the user was charged, which it is not: the rate depends on the model and on
 * whether the session bills against a subscription or an API key, so the same
 * recovery is a different amount of money for different people. Tokens are the
 * quantity phantom actually consumed and are true for everyone.
 */
function formatTokens(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return 'n/a';
  if (tokens < 1000) return tokens + ' tokens';
  if (tokens < 1e6) return (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k tokens';
  return (tokens / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M tokens';
}

/**
 * Total tokens billed for one Claude session: prompt, completion, and both
 * halves of the cache. Cache reads are discounted, not free, so they belong in
 * the total -- and leaving them out would understate a long session by an order
 * of magnitude, since most of a resumed session's input is cache.
 * @param {{ input_tokens?: number, output_tokens?: number,
 *           cache_creation_input_tokens?: number, cache_read_input_tokens?: number }} [usage]
 */
function sumTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const fields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  return fields.reduce((n, f) => n + (Number.isFinite(usage[f]) ? usage[f] : 0), 0);
}

const shortSha = (sha) => (sha ? String(sha).slice(0, 10) : 'unknown');
const describeCommand = (ctx) => [ctx.command, ...(ctx.args || [])].join(' ');
const code = (s) => '`' + String(s).replace(/`/g, '‵') + '`';

/**
 * Complete report written by phantom when Claude produced none. Keeps the
 * verification marker so `appendVerification` can fill in the facts.
 * @param {import('./context').CrashContext} ctx
 * @param {{ status: string, branch: string|null, reportPath: string|null, iterations: number, message: string }} result
 * @param {{ claudeResult?: object|null, testOutput?: string|null, baseSha?: string|null, durationMs?: number }} [extra]
 * @returns {string}
 */
/** Claude Code keeps the full transcript under ~/.claude/projects/; the id is how you find or reopen it. */
function sessionCell(id) {
  return id ? code(id) + ' — transcript in `~/.claude/projects/`, reopen with ' + code('claude --resume ' + id) : '(none)';
}

function fallbackReport(ctx, result, extra = {}) {
  const claude = extra.claudeResult || null;
  const baseBranch = (ctx.git && ctx.git.branch) || 'HEAD';
  const baseSha = shortSha(extra.baseSha || (ctx.git && ctx.git.headSha));
  const branch = result.branch || '(no branch)';
  const summary = ctx.errorLine || summarizeExit(ctx);
  const modelUsage = claude
    ? [claude.model || null, formatTokens(sumTokens(claude.usage)), claude.num_turns !== undefined ? claude.num_turns + ' turns' : null].filter(Boolean).join(' · ')
    : 'n/a';
  const lines = [
    '# 👻 Phantom post-mortem — ' + summary,
    '',
    '> **Status:** ' + statusBadge(result.status),
    '>',
    '> Phantom wrote this report because the recovery session did not produce one.',
    '',
    '| | |',
    '|---|---|',
    '| **Command** | ' + code(describeCommand(ctx)) + ' |',
    '| **Exit** | ' + summarizeExit(ctx) + ' |',
    '| **Branch** | ' + code(branch) + ' (from ' + code(baseBranch) + ' @ ' + code(baseSha) + ') |',
    '| **Iterations** | ' + (result.iterations || 0) + ' |',
    '| **Duration** | ' + formatDuration(extra.durationMs) + ' |',
    '| **Model / tokens** | ' + modelUsage + ' |',
    '| **Session** | ' + sessionCell(claude && claude.session_id) + ' |',
    '| **Generated** | ' + new Date().toISOString() + ' |',
    '',
    '## TL;DR',
    '',
    result.message || 'Recovery ended with status ' + result.status + '.',
    '',
    '## Crash',
    '',
    '**Error:** ' + code(ctx.errorLine || 'no error line detected'),
    '',
    '```text',
    trimLines(ctx.stackTrace || ctx.tail || '(no output captured)', 25),
    '```',
    '',
    ctx.hintFiles && ctx.hintFiles.length ? 'Files named in the trace: ' + ctx.hintFiles.map(code).join(', ') : 'No project files were named in the trace.',
    '',
    "## Claude's final message",
    '',
    claude && claude.result ? String(claude.result).trim() : '_The session returned no final message._',
    '',
    claude && claude.subtype && claude.subtype !== 'success' ? 'Session ended with `' + claude.subtype + '`.' : '',
    claude && Array.isArray(claude.permission_denials) && claude.permission_denials.length
      ? 'Denied tool calls: ' + claude.permission_denials.map((d) => code(d.tool_name + ' ' + JSON.stringify(d.tool_input || {}).slice(0, 80))).join(', ')
      : '',
    '',
    '## Verification',
    '',
    VERIFICATION_MARKER,
    '',
    '## How to review',
    '',
    '```bash',
    'git diff ' + baseBranch + '..' + branch,
    'git log --oneline ' + baseBranch + '..' + branch,
    'git merge ' + branch + '     # accept',
    'git branch -D ' + branch + ' # reject',
    '```',
    '',
    result.reportPath ? 'Report: ' + code(result.reportPath) : '',
    '',
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Replace the verification marker (or append a section) with phantom's own
 * independent checks.
 * @param {string} markdown
 * @param {{ status: string, testCommand: string|null, testOutput: string|null, iterations: number, durationMs: number,
 *           tokens: number|null, changedFiles: string[], branch: string|null, baseSha: string|null, baseBranch: string|null,
 *           restoreHint?: string|null, neverTouchViolations?: string[], testsPassed?: boolean|null }} info
 * @returns {string}
 */
function appendVerification(markdown, info) {
  const passed = info.testsPassed !== undefined && info.testsPassed !== null ? info.testsPassed : info.status === 'fixed';
  const testCell = info.testCommand
    ? (info.testOutput === null || info.testOutput === undefined ? '⏭ not run' : passed ? '✅ passed' : '❌ failed') + ' — ' + code(info.testCommand)
    : '⏭ no test command configured';
  const files = info.changedFiles && info.changedFiles.length ? info.changedFiles.map(code).join(', ') : 'none';
  const violations = info.neverTouchViolations || [];
  const audit = violations.length ? '❌ violated — ' + violations.map(code).join(', ') + ' (branch hard-reverted)' : '✅ clean';
  const rows = [
    ['Tests run by phantom', testCell],
    ['Files changed', files],
    ['Never-touch audit', audit],
    ['Branch', info.branch
      ? code(info.branch) + ' from ' + code(info.baseBranch || 'HEAD') + ' @ ' + code(shortSha(info.baseSha))
      : info.status === 'dry-run' ? 'none (dry run)' : 'none (no changes were made; the empty branch was removed)'],
    ['Iterations used', String(info.iterations || 0)],
    ['Wall clock', formatDuration(info.durationMs)],
    ['Tokens', formatTokens(info.tokens)],
    ['Session', sessionCell(info.sessionId)],
  ];
  if (info.restoreHint) rows.push(['Stashed changes', 'restore with ' + code(info.restoreHint)]);
  const section = [
    '## Verification (independent)',
    '',
    '| Check | Result |',
    '|---|---|',
    ...rows.map(([k, v]) => '| ' + k + ' | ' + v + ' |'),
    '',
    '<details>',
    '<summary>Test output (last 40 lines)</summary>',
    '',
    '```text',
    trimLines(info.testOutput || '(no output)', 40),
    '```',
    '',
    '</details>',
  ].join('\n');
  const at = markdown.indexOf(VERIFICATION_MARKER);
  if (at === -1) return markdown.replace(/\s*$/, '\n\n') + section + '\n';
  // The template already carries a "## Verification" heading (possibly followed
  // by instruction comments) right before the marker: upgrade it, do not duplicate it.
  const before = markdown.slice(0, at);
  const heading = /## Verification[^\n]*\n(?:\s|<!--(?!\s*phantom:verification)[\s\S]*?-->)*$/;
  if (heading.test(before)) {
    const body = section.replace(/^## Verification \(independent\)\n\n/, '');
    const upgraded = before.replace(heading, '## Verification (independent)\n\n');
    return upgraded + body + markdown.slice(at + VERIFICATION_MARKER.length);
  }
  return markdown.replace(VERIFICATION_MARKER, section);
}

module.exports = {
  renderTemplate, fallbackReport, appendVerification, trimLines, trimBytes, loadTemplate,
  statusBadge, formatDuration, formatTokens, sumTokens, sessionCell, VERIFICATION_MARKER, TEMPLATE_PATH,
};
