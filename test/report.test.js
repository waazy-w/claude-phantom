'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  renderTemplate, fallbackReport, appendVerification, trimLines, trimBytes, loadTemplate, VERIFICATION_MARKER,
  formatTokens, sumTokens, cachedTokens,
} = require('../src/report');

const ctx = {
  command: 'node', args: ['src/server.js'], cwd: '/repo', exitCode: 1, signal: null,
  errorLine: "TypeError: Cannot read properties of undefined (reading 'total')",
  stackTrace: "TypeError: Cannot read properties of undefined (reading 'total')\n    at sum (src/report.js:12:20)",
  hintFiles: ['src/report.js'], slug: 'typeerror-cannot-read', tail: 'boot\ncrash',
  git: { root: '/repo', branch: 'main', headSha: 'abc1234def', dirty: false, status: '', recentCommits: [] },
  pkg: { name: 'demo', scripts: { test: 'node --test' } }, testCommand: 'npm test', capturedAt: '2026-08-20T00:00:00Z',
};

test('renderTemplate substitutes known placeholders and leaves unknown ones', () => {
  const out = renderTemplate('a {{x}} b {{y}} c {{x}}', { x: '1' });
  assert.equal(out, 'a 1 b {{y}} c 1');
});

test('renderTemplate stringifies non-string values and keeps empty strings', () => {
  assert.equal(renderTemplate('{{n}}|{{e}}|{{z}}', { n: 3, e: '', z: null }), '3||');
});

test('trimLines keeps the last n lines and notes the cut', () => {
  const text = Array.from({ length: 10 }, (_, i) => 'l' + i).join('\n');
  const out = trimLines(text, 3);
  assert.match(out, /7 lines trimmed/);
  assert.ok(out.endsWith('l7\nl8\nl9'));
  assert.equal(trimLines('a\nb', 5), 'a\nb');
});

test('trimBytes keeps the tail within the budget', () => {
  const text = 'x'.repeat(1000) + 'END';
  const out = trimBytes(text, 100);
  assert.ok(Buffer.byteLength(out) <= 100 + 40);
  assert.ok(out.endsWith('END'));
  assert.match(out, /trimmed/);
  assert.equal(trimBytes('short', 100), 'short');
});

test('loadTemplate reads the shipped template with its marker', () => {
  const tpl = loadTemplate();
  assert.ok(tpl.includes(VERIFICATION_MARKER));
  assert.ok(tpl.includes('{{status}}'));
  const shipped = fs.readFileSync(path.join(__dirname, '..', 'templates', 'post-mortem.md'), 'utf8');
  assert.equal(tpl, shipped);
});

test('fallbackReport is complete when Claude wrote nothing', () => {
  const result = { status: 'unfixed', branch: 'phantom/fix-x', reportPath: '/repo/.phantom/reports/r.md', iterations: 2, testsPassed: false, message: 'tests still failing' };
  const md = fallbackReport(ctx, result, {
    claudeResult: { result: 'I tried but could not.', session_id: 's1', usage: { input_tokens: 50, output_tokens: 450, cache_read_input_tokens: 2000 }, num_turns: 9 },
    testOutput: 'not ok 1 - sum\n',
    baseSha: 'abc1234def',
  });
  assert.match(md, /^# 👻 Phantom post-mortem — TypeError/m);
  assert.match(md, /❌ UNFIXED/);
  assert.match(md, /node src\/server\.js/);
  assert.match(md, /## Crash/);
  assert.match(md, /at sum \(src\/report\.js:12:20\)/);
  assert.match(md, /## Claude's final message/);
  assert.match(md, /I tried but could not\./);
  assert.ok(md.includes(VERIFICATION_MARKER), 'fallback keeps the marker for appendVerification');
  assert.match(md, /git diff main\.\.phantom\/fix-x/);
});

test('fallbackReport maps every status to a badge', () => {
  const badge = (status) => fallbackReport(ctx, { status, branch: null, reportPath: null, iterations: 0, testsPassed: null, message: '' }, {});
  assert.match(badge('fixed'), /✅ FIXED/);
  assert.match(badge('dry-run'), /🔍 DRY RUN/);
  assert.match(badge('timeout'), /❌ UNFIXED/);
  assert.match(badge('error'), /❌ UNFIXED/);
  assert.match(badge('refused'), /⚠️ PARTIAL/);
});

test('appendVerification replaces the marker with a table and trimmed output', () => {
  const md = '# title\n\n## Verification\n\n' + VERIFICATION_MARKER + '\n\n## Next\n';
  const out = appendVerification(md, {
    status: 'fixed', testCommand: 'npm test', testOutput: Array.from({ length: 60 }, (_, i) => 'line' + i).join('\n'),
    iterations: 2, durationMs: 125000, tokens: 118450, changedFiles: ['src/a.js', 'test/a.test.js'],
    branch: 'phantom/fix-x', baseSha: 'abc1234def0', baseBranch: 'main', restoreHint: null,
  });
  assert.ok(!out.includes(VERIFICATION_MARKER));
  assert.match(out, /\| Check \| Result \|/);
  assert.match(out, /✅ passed.*`npm test`/);
  assert.match(out, /`src\/a\.js`, `test\/a\.test\.js`/);
  assert.match(out, /never-touch audit.*✅ clean/i);
  assert.match(out, /2m 5s/);
  assert.match(out, /118\.5k tokens/);
  assert.match(out, /line59/);
  assert.ok(!out.includes('line10\n'), 'only the last 40 lines are kept');
  assert.match(out, /20 lines trimmed/);
  assert.ok(out.indexOf('## Next') > out.indexOf('line59'));
});

test('appendVerification appends when the marker is missing and reports failures', () => {
  const out = appendVerification('# no marker\n', {
    status: 'unfixed', testCommand: 'npm test', testOutput: 'not ok', iterations: 3, durationMs: 4000, tokens: null,
    changedFiles: [], branch: 'phantom/fix-y', baseSha: 'abc', baseBranch: 'main', restoreHint: 'git stash pop',
    neverTouchViolations: ['.env'],
  });
  assert.match(out, /## Verification \(independent\)/);
  assert.match(out, /❌ failed/);
  assert.match(out, /none/);
  assert.match(out, /❌ violated.*`\.env`/);
  assert.match(out, /git stash pop/);
  assert.match(out, /n\/a/);
});

test('appendVerification reuses the template heading instead of duplicating it', () => {
  const tpl = loadTemplate();
  const out = appendVerification(tpl, {
    status: 'fixed', testCommand: 'npm test', testOutput: 'ok', iterations: 1, durationMs: 1000, tokens: 900,
    changedFiles: ['a.js'], branch: 'b', baseSha: 'abc', baseBranch: 'main',
  });
  assert.equal((out.match(/^## Verification/gm) || []).length, 1, out);
  assert.match(out, /## Verification \(independent\)\n\n\| Check \| Result \|/);
  assert.ok(!out.includes('Leave the marker below'));
  assert.ok(out.indexOf('## Alternatives') > out.indexOf('| Tokens |'));
});

test('sumTokens counts prompt, completion, and both halves of the cache', () => {
  assert.equal(sumTokens({
    input_tokens: 120, output_tokens: 880, cache_creation_input_tokens: 4000, cache_read_input_tokens: 7200,
  }), 12200);
  // Cache reads dominate a resumed session; dropping them would understate it.
  assert.equal(sumTokens({ input_tokens: 10, cache_read_input_tokens: 990 }), 1000);
  assert.equal(sumTokens({ input_tokens: 5, unknown_field: 999 }), 5, 'unknown fields are ignored');
  assert.equal(sumTokens({ input_tokens: 'lots', output_tokens: 3 }), 3, 'non-numeric fields are ignored');
  for (const empty of [undefined, null, {}, 'nope', 42]) assert.equal(sumTokens(empty), 0);
});

test('formatTokens scales units and never reports a dollar figure', () => {
  assert.equal(formatTokens(0), '0 tokens');
  assert.equal(formatTokens(999), '999 tokens');
  assert.equal(formatTokens(1000), '1k tokens');
  assert.equal(formatTokens(12200), '12.2k tokens');
  assert.equal(formatTokens(999999), '1000k tokens');
  assert.equal(formatTokens(1e6), '1M tokens');
  assert.equal(formatTokens(2450000), '2.45M tokens');
  assert.equal(formatTokens(3200000), '3.2M tokens');
  for (const bad of [null, undefined, NaN, Infinity, -1, '900']) assert.equal(formatTokens(bad), 'n/a');
});

test('no rendered report mentions a dollar amount', () => {
  const md = appendVerification(loadTemplate(), {
    status: 'fixed', testCommand: 'npm test', testOutput: 'ok', iterations: 1, durationMs: 1000, tokens: 12200,
    changedFiles: ['a.js'], branch: 'b', baseSha: 'abc', baseBranch: 'main',
  });
  assert.match(md, /12\.2k tokens/);
  assert.ok(!/\$\d/.test(md), 'a dollar figure would misstate what the user was charged');
  assert.ok(!/cost/i.test(md.split('## Verification (independent)')[1] || ''), md);
});

test('cachedTokens picks out the discounted half of the total', () => {
  assert.equal(cachedTokens({ input_tokens: 10, cache_read_input_tokens: 456000 }), 456000);
  assert.equal(cachedTokens({ input_tokens: 10 }), 0, 'a session with no cache reads');
  for (const empty of [undefined, null, {}, 'nope', 7]) assert.equal(cachedTokens(empty), 0);
});

test('formatTokens shows what was new, so the total can be judged', () => {
  // The number this exists for: a one-iteration recovery reports ~468k tokens,
  // which reads as enormous until you see that all but 12k of it is the same
  // prompt and files re-read each turn and billed as discounted cache reads.
  assert.equal(formatTokens(468200, 456000), '468.2k tokens (12.2k new · 456k cached)');
  assert.equal(formatTokens(1000, 900), '1k tokens (100 new · 900 cached)');

  // Without a usable cached figure it stays a plain total rather than guessing.
  assert.equal(formatTokens(12200), '12.2k tokens');
  assert.equal(formatTokens(12200, 0), '12.2k tokens', 'nothing was cached');
  assert.equal(formatTokens(12200, 99999), '12.2k tokens', 'cached cannot exceed the total');
  assert.equal(formatTokens(12200, NaN), '12.2k tokens');
  assert.equal(formatTokens(null, 500), 'n/a');
});
