'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPrompt, buildResumePrompt, buildAllowedTools, buildDisallowedTools, buildSettings, buildClaudeArgs, buildClaudeEnv,
  loadSkill, CONTEXT_BYTE_BUDGET,
} = require('../src/prompt');
const { VERIFICATION_MARKER } = require('../src/report');

const config = {
  testCommand: 'npm run test:unit', maxIterations: 3, maxMinutes: 15, model: null,
  neverTouch: ['.env', '.env.*', '**/*.pem', '**/secrets/**', '.git/**', 'node_modules/**'],
};
const ctx = {
  command: 'node', args: ['src/server.js', '--port', '3000'], cwd: '/repo', exitCode: 1, signal: null,
  errorLine: "TypeError: Cannot read properties of undefined (reading 'total')",
  stackTrace: "TypeError: Cannot read properties of undefined (reading 'total')\n    at sum (/repo/src/report.js:12:20)\n    at main (/repo/src/server.js:40:5)",
  hintFiles: ['src/report.js', 'src/server.js'], slug: 'typeerror', tail: 'listening on 3000\nAPI_KEY=sk-live-abcdefghijklmnopqrstuvwxyz\ncrash!',
  git: { root: '/repo', branch: 'main', detached: false, headSha: 'abc1234def5678', dirty: false, status: '', recentCommits: ['abc1234 initial'] },
  pkg: { name: 'demo', scripts: { test: 'node --test', 'test:unit': 'node --test test/unit' } }, testCommand: 'npm run test:unit',
  capturedAt: '2026-08-20T00:00:00Z',
};
const opts = { reportPath: '/repo/.phantom/reports/20260820-typeerror.md', attempt: 1, maxAttempts: 3, branch: 'phantom/fix-typeerror-123', baseSha: 'abc1234def5678' };

test('buildPrompt embeds skill, template, context, report path and redacts secrets', () => {
  const p = buildPrompt(ctx, config, opts);
  assert.ok(p.includes(ctx.errorLine));
  assert.ok(p.includes(opts.reportPath));
  assert.ok(p.includes('## Phase 0 - Orient'), 'skill body embedded');
  assert.ok(!p.includes('name: crash-recovery'), 'frontmatter stripped');
  assert.ok(p.includes(VERIFICATION_MARKER));
  assert.ok(p.includes('`node src/server.js --port 3000`'));
  assert.ok(p.includes('phantom/fix-typeerror-123'));
  assert.ok(p.includes('Outer attempt: 1 of 3'));
  assert.ok(p.includes('`.env`, `.env.*`, `**/*.pem`'));
  assert.ok(p.includes('npm run test:unit'));
  assert.ok(!p.includes('sk-live-abcdefghijklmnopqrstuvwxyz'), 'secret redacted');
  assert.match(p, /## Crash context \(\d+ values? redacted\)/);
  assert.ok(p.includes('{{iterations}}') && p.includes('{{duration}}') && p.includes('{{modelUsage}}'), 'phantom-filled placeholders kept');
  assert.ok(!p.includes('{{reportPath}}') && !p.includes('{{command}}'), 'known placeholders rendered');
  assert.ok(p.includes('Mode: **FIX**'));
});

test('buildPrompt stays within the byte budget with a 5 MB tail', () => {
  const big = { ...ctx, tail: 'x'.repeat(5 * 1024 * 1024) + '\nlast line here' };
  const p = buildPrompt(big, config, opts);
  const ctxStart = p.indexOf('## Crash context');
  const ctxEnd = p.indexOf('## Report template');
  assert.ok(ctxStart > 0 && ctxEnd > ctxStart);
  assert.ok(Buffer.byteLength(p.slice(ctxStart, ctxEnd)) <= CONTEXT_BYTE_BUDGET + 512, 'context block within budget');
  assert.ok(p.includes('last line here'));
  assert.ok(Buffer.byteLength(p) < 80 * 1024);
});

test('buildPrompt dry-run variant says so and pre-fills the status', () => {
  const p = buildPrompt(ctx, config, { ...opts, dryRun: true, branch: null });
  assert.ok(p.includes('Mode: **DRY RUN**'));
  assert.ok(p.includes('🔍 DRY RUN'));
  assert.ok(p.includes('(dry run: no branch)'));
});

test('buildResumePrompt is short and carries the test output', () => {
  const p = buildResumePrompt('not ok 1 - sum\n  expected 3, got NaN', 2, 3, { testCommand: 'npm test', reportPath: '/r/x.md' });
  assert.ok(p.length < 2000);
  assert.ok(p.includes('attempt 2 of 3'));
  assert.ok(p.includes('expected 3, got NaN'));
  assert.ok(p.includes('never the test expectations'));
  assert.ok(!p.includes('Phase 0 - Orient'));
  assert.ok(buildResumePrompt('x', 3, 3).includes('last attempt'));
});

test('buildAllowedTools includes the test command and never push', () => {
  const tools = buildAllowedTools(config, { testCommand: 'npm run test:unit' });
  assert.ok(tools.includes('Bash(npm run test:unit)'));
  assert.ok(tools.includes('Bash(npm run test:unit *)'));
  for (const t of ['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'Bash(node *)', 'Bash(git diff *)', 'Bash(ls)', 'Bash(ls *)']) assert.ok(tools.includes(t), t);
  assert.ok(!tools.some((t) => /push|checkout|reset|stash|curl|rm /.test(t)));
  const dry = buildAllowedTools(config, { dryRun: true, testCommand: 'npm test' });
  assert.ok(!dry.includes('Edit') && !dry.includes('MultiEdit'));
  assert.ok(dry.includes('Write') && dry.includes('Read'));
  assert.ok(dry.includes('Bash(npm test)'));
  assert.equal(new Set(dry).size, dry.length);
});

test('buildDisallowedTools blocks network, subagents and git mutations', () => {
  const d = buildDisallowedTools();
  for (const t of ['WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'Bash(git push *)', 'Bash(git checkout *)', 'Bash(rm *)', 'Bash(sudo *)']) assert.ok(d.includes(t), t);
});

test('buildSettings denies every never-touch glob for file tools and wires the hook', () => {
  const guard = JSON.stringify({ neverTouch: config.neverTouch, cwd: '/repo', dryRun: false, testCommand: 'npm test', reportPath: "/repo/it's/r.md" });
  const s = buildSettings(config, guard, '/opt/phantom/src/guard-hook.js', { platform: 'darwin' });
  for (const g of config.neverTouch) {
    assert.ok(s.permissions.deny.includes('Read(' + g + ')'), g);
    assert.ok(s.permissions.deny.includes('Edit(' + g + ')'), g);
    assert.ok(s.permissions.deny.includes('Write(' + g + ')'), g);
    assert.ok(s.permissions.deny.includes('Grep(' + g + ')'), g);
  }
  assert.ok(s.permissions.deny.includes('Bash(git push *)'));
  assert.ok(s.permissions.deny.includes('Bash(rm *)'));
  const hook = s.hooks.PreToolUse[0];
  assert.match(hook.matcher, /Bash/);
  assert.match(hook.matcher, /Edit/);
  const cmd = hook.hooks[0].command;
  assert.ok(cmd.startsWith("PHANTOM_GUARD='"));
  assert.ok(cmd.endsWith("'/opt/phantom/src/guard-hook.js'"));
  assert.ok(cmd.includes("it'\\''s"), 'single quotes escaped: ' + cmd);
  assert.equal(hook.hooks[0].type, 'command');
  assert.ok(JSON.parse(JSON.stringify(s)));
});

test('buildSettings skips the hook on win32 with a warning', () => {
  const warnings = [];
  const s = buildSettings(config, '{}', '/x/guard-hook.js', { platform: 'win32', warn: (m) => warnings.push(m) });
  assert.equal(s.hooks, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(s.permissions.deny.length > 0);
});

test('buildClaudeArgs produces a spawn argv with stdin prompt and resume support', () => {
  const args = buildClaudeArgs({ settings: { permissions: { deny: [] } }, allowedTools: ['Read', 'Bash(npm test)'], disallowedTools: ['WebFetch'], model: 'sonnet' });
  assert.equal(args[0], '-p');
  assert.ok(args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json');
  assert.ok(args.includes('dontAsk'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local', 'user-level settings are not loaded');
  assert.ok(args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--allowedTools') + 2], 'Bash(npm test)');
  assert.ok(args.includes('--settings'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { permissions: { deny: [] } });
  assert.ok(args.includes('--model') && args.includes('sonnet'));
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--no-session-persistence'));
  const resumed = buildClaudeArgs({ settings: {}, allowedTools: [], disallowedTools: [], resumeSessionId: 'abc-123' });
  assert.ok(resumed.includes('--resume') && resumed.includes('abc-123'));
  assert.equal(resumed[resumed.indexOf('--max-turns') + 1], '40');
});

test('buildClaudeEnv strips nested-session markers', () => {
  const env = buildClaudeEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('loadSkill reads the shipped procedure', () => {
  const s = loadSkill();
  assert.ok(s.startsWith('# Crash recovery procedure'));
  assert.ok(s.includes('## Dry-run variant'));
});
