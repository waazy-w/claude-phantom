'use strict';

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
  buildPrompt, buildResumePrompt, buildAllowedTools, buildDisallowedTools, buildSettings, buildClaudeArgs, buildClaudeEnv,
  loadSkill, CONTEXT_BYTE_BUDGET, PHANTOM_FILLS, SKILL_PATH, DEFAULT_MAX_TURNS, RESUME_MAX_TURNS,
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

test('buildSettings skips the hook on win32 only when it has nowhere to put the config', () => {
  const warnings = [];
  const s = buildSettings(config, '{}', '/x/guard-hook.js', { platform: 'win32', warn: (m) => warnings.push(m) });
  assert.equal(s.hooks, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(s.permissions.deny.length > 0);
});

test('given a guard file, win32 registers the same hook as everyone else', () => {
  // The hook used to be skipped on Windows outright, because the POSIX command
  // carries its config in a `VAR=value` prefix that cmd.exe does not understand.
  // The deny rules that remained cover Read/Edit/Write/Grep/Glob but NOT Bash,
  // while the allowlist grants Bash(cat *) -- so `cat .env` was unguarded on
  // Windows alone. The payload goes in a file now and the hook reads it from
  // argv, so every platform gets the same guard.
  const warnings = [];
  const s = buildSettings(config, '{"neverTouch":[".env"]}', 'C:\\p\\guard-hook.js',
    { platform: 'win32', warn: (m) => warnings.push(m), guardFilePath: 'C:\\p\\.phantom\\.guard.json' });
  assert.deepEqual(warnings, [], 'nothing to warn about once the hook is registered');
  const hook = s.hooks.PreToolUse[0];
  assert.match(hook.matcher, /Bash/, 'Bash is what the deny rules cannot cover');
  const command = hook.hooks[0].command;
  assert.ok(!command.includes('PHANTOM_GUARD='), 'no POSIX env prefix: cmd.exe would treat it as the program name');
  assert.ok(command.includes('"C:\\p\\guard-hook.js"') && command.includes('"C:\\p\\.phantom\\.guard.json"'),
    'both paths quoted for cmd.exe: ' + command);
  assert.ok(command.startsWith('"'), 'the interpreter is quoted too — Program Files has a space in it');
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

// --- Safety envelope -------------------------------------------------------
// The deny rules are the only thing standing between a fully autonomous session
// and a `git push`/`rm -rf`, so they are pinned byte-for-byte here: a rule
// silently dropped from src/prompt.js must break this file, not production.
const BASH_DENY = [
  'Bash(git push *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git reset *)', 'Bash(git stash *)',
  'Bash(git rebase *)', 'Bash(git commit *)', 'Bash(git clean *)', 'Bash(git merge *)', 'Bash(git branch -D *)',
  'Bash(rm *)', 'Bash(rmdir *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(ssh *)', 'Bash(scp *)',
  'Bash(npm install *)', 'Bash(npm install)', 'Bash(npm i *)', 'Bash(npm ci *)', 'Bash(npm ci)', 'Bash(npm uninstall *)',
  'Bash(yarn add *)', 'Bash(pnpm add *)', 'Bash(pip install *)', 'Bash(npx prisma *)', 'Bash(sudo *)',
  'Bash(chmod -R *)', 'Bash(chown *)', 'Bash(docker *)', 'Bash(kubectl *)', 'Bash(pkill *)', 'Bash(killall *)',
];

function lineStarting(p, prefix) {
  return p.split('\n').find((l) => l.startsWith(prefix));
}

/** The parts phantom itself writes: the briefing header and the crash context.
 * The skill body and the report template are static prose that legitimately
 * contains words like "undefined", so leak checks must exclude them. */
function phantomWritten(p) {
  return p.slice(0, p.indexOf('## Procedure')) + p.slice(p.indexOf('## Crash context'), p.indexOf('## Report template'));
}

test('every hard-rule bash deny survives into the argv handed to claude', () => {
  const settings = buildSettings(config, '{}', '/x/guard-hook.js', { platform: 'darwin' });
  const args = buildClaudeArgs({ settings, allowedTools: ['Read'], disallowedTools: buildDisallowedTools() });
  // Assert on what is actually serialised, not on the intermediate object: a rule
  // that cannot survive JSON is a rule claude never sees.
  const shipped = JSON.parse(args[args.indexOf('--settings') + 1]).permissions.deny;
  for (const rule of BASH_DENY) assert.ok(shipped.includes(rule), 'missing deny rule ' + rule);
  assert.equal(new Set(shipped).size, shipped.length, 'deny rules deduped');
});

test('disallowedTools never claims a bash rule the settings deny does not also cover', () => {
  // Two independent layers reach claude (--disallowedTools and --settings). If they
  // disagree the weaker one silently defines the envelope.
  const deny = buildSettings(config, '{}', '/x/g.js', { platform: 'darwin' }).permissions.deny;
  for (const rule of buildDisallowedTools().filter((t) => t.startsWith('Bash('))) {
    assert.ok(deny.includes(rule), rule + ' is disallowed but not denied');
  }
});

test('no allowed tool grants something the deny rules block', () => {
  const allowed = buildAllowedTools(config, { testCommand: 'npm run test:unit' });
  const deny = new Set(buildSettings(config, '{}', '/x/g.js', { platform: 'darwin' }).permissions.deny);
  const disallowed = new Set(buildDisallowedTools());
  for (const t of allowed) {
    assert.ok(!deny.has(t), 'allowed and denied: ' + t);
    assert.ok(!disallowed.has(t), 'allowed and disallowed: ' + t);
  }
});

test('never-touch globs come from the caller config and cover all six file tools', () => {
  const custom = { neverTouch: ['config/prod.yaml', 'infra/**'] };
  const deny = buildSettings(custom, '{}', '/x/g.js', { platform: 'darwin' }).permissions.deny;
  for (const glob of custom.neverTouch) {
    for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob']) {
      assert.ok(deny.includes(tool + '(' + glob + ')'), tool + '(' + glob + ')');
    }
  }
  assert.ok(!deny.some((r) => r.includes('.env')), 'default globs not smuggled in');
  assert.ok(deny.includes('Bash(git push *)'), 'bash rules still appended');
});

test('a config with no neverTouch denies bash only and invents no rules', () => {
  const deny = buildSettings({}, '{}', '/x/g.js', { platform: 'darwin' }).permissions.deny;
  assert.deepEqual(deny, BASH_DENY);
});

test('buildSettings defaults to the shipped guard hook and the current platform', () => {
  const s = buildSettings(config, '{"cwd":"/repo"}');
  if (process.platform === 'win32') {
    assert.equal(s.hooks, undefined, 'hook is skipped on Windows');
  } else {
    const cmd = s.hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.includes(path.join('src', 'guard-hook.js')), 'defaults to the shipped hook: ' + cmd);
    assert.ok(cmd.includes(process.execPath), 'runs the hook with this node');
    assert.equal(s.hooks.PreToolUse[0].hooks[0].timeout, 10);
  }
  assert.ok(s.permissions.deny.includes('Bash(rm *)'));
});

test('buildSettings on win32 without a warn callback still returns the deny rules', () => {
  // recovery.js always passes warn, but the parameter is optional; an unguarded
  // call would throw and take the whole session down instead of degrading.
  const s = buildSettings(config, '{}', '/x/g.js', { platform: 'win32' });
  assert.equal(s.hooks, undefined);
  assert.ok(s.permissions.deny.includes('Bash(git push *)'));
});

test('buildAllowedTools falls back to config.testCommand and omits the rule when there is none', () => {
  const fromConfig = buildAllowedTools(config, {});
  assert.ok(fromConfig.includes('Bash(npm run test:unit)'), 'config.testCommand used when opts has none');
  const none = buildAllowedTools({});
  assert.ok(!none.some((t) => /Bash\(\s*(undefined|null)?\s*\*?\)/.test(t)), 'no placeholder bash rule: ' + none.join(','));
  assert.equal(none.length, buildAllowedTools({ testCommand: 'x' }).length - 2, 'exactly the two test-command rules are dropped');
  assert.ok(none.includes('Bash(npm test)'), 'generic runners still allowed');
  assert.ok(none.includes('Read') && none.includes('Edit'));
});

// --- Degenerate context ----------------------------------------------------

test('a bare context omits every optional section instead of printing undefined', () => {
  const bare = { command: 'sh', cwd: '/tmp/x' };
  const p = buildPrompt(bare, {}, { reportPath: '/r.md' });
  assert.ok(p.includes('- git: not a repository'));
  assert.ok(p.includes('- package.json: none found'));
  assert.ok(p.includes('- error line: (none detected)'));
  assert.ok(p.includes('- files named in the trace: (none)'));
  assert.ok(p.includes('- test command: (none configured; see Phase 2)'));
  assert.ok(p.includes('(no stack trace extracted'));
  assert.ok(p.includes('(no output captured)'));
  assert.ok(p.includes('exit: unknown exit'));
  assert.ok(p.includes('Work only inside the repository at `/tmp/x`'), 'falls back to cwd without git');
  assert.ok(p.includes('(from `HEAD`'), 'base branch falls back to HEAD');
  assert.ok(p.includes('post-mortem — unknown exit'), 'error summary falls back to the exit summary');
  assert.ok(!/undefined|\bnull\b/.test(phantomWritten(p)), 'no undefined/null leaked into the briefing');
});

test('git section reports detached HEAD, a dirty tree, a missing sha and no commits', () => {
  const ctx2 = { ...ctx, git: { root: '/repo', branch: 'HEAD', detached: true, headSha: null, dirty: true, recentCommits: [] } };
  const p = buildPrompt(ctx2, config, { ...opts, baseSha: null });
  assert.ok(p.includes('(detached HEAD)'));
  assert.ok(p.includes('dirty before recovery: yes (stashed by phantom)'));
  assert.ok(!p.includes('- recent commits:'), 'empty commit list omits the section');
  assert.equal(lineStarting(p, '- branch:'), '- branch: `HEAD` (detached HEAD) @ ``', 'a missing sha renders empty, not undefined');
});

test('package.json with no scripts and no name degrades to a one-liner', () => {
  const noScripts = buildPrompt({ ...ctx, pkg: { name: 'demo', scripts: {} } }, config, opts);
  assert.ok(noScripts.includes('- package.json `demo`: no scripts'));
  const noName = buildPrompt({ ...ctx, pkg: { scripts: { build: 'tsc' } } }, config, opts);
  assert.ok(noName.includes('scripts:'), 'scripts still listed without a name');
  assert.ok(noName.includes('build: tsc'));
  assert.equal(lineStarting(noName, '- package.json'), '- package.json `` scripts:', 'a nameless package renders empty backticks');
});

test('a command with no args and no git still describes itself', () => {
  const p = buildPrompt({ command: 'pytest', cwd: '/w', exitCode: 2 }, {}, { reportPath: '/r.md' });
  assert.ok(p.includes('- command: `pytest`'), 'missing args array does not throw or trail a space');
});

test('a literal fence in the captured output cannot close the crash-context block', () => {
  const fenced = '```js\nconst x = 1;\n```\nboom';
  const withFence = buildPrompt({ ...ctx, tail: fenced }, config, opts);
  const control = buildPrompt({ ...ctx, tail: 'plain output\nboom' }, config, opts);
  const count = (s) => s.split('```').length - 1;
  assert.equal(count(withFence), count(control), 'the tail added no new fence delimiters');
  assert.ok(withFence.includes('`\u200b``js'), 'fence escaped with a zero-width space');
  assert.ok(withFence.includes('const x = 1;'), 'the escaped content is still readable');
});

test('the captured tail is trimmed to the newest lines', () => {
  const lines = Array.from({ length: 500 }, (_, i) => 'line-' + (i + 1));
  const p = buildPrompt({ ...ctx, tail: lines.join('\n') }, config, opts);
  assert.ok(p.includes('line-500\n'), 'newest line kept');
  assert.ok(p.includes('line-301\n'), 'exactly the last 200 lines kept');
  assert.ok(!p.includes('line-300\n'), 'older lines dropped');
  assert.ok(!p.includes('line-1\n'));
  assert.match(p, /lines trimmed/);
});

test('a head larger than the whole budget still leaves the minimum tail', () => {
  // hintFiles/recentCommits are unbounded, so the head alone can exceed
  // CONTEXT_BYTE_BUDGET; the tail must not be squeezed to nothing.
  const huge = {
    ...ctx,
    hintFiles: Array.from({ length: 800 }, (_, i) => 'src/very/deeply/nested/module-' + i + '.js'),
    tail: Array.from({ length: 4000 }, (_, i) => 'output line number ' + i).join('\n'),
  };
  const p = buildPrompt(huge, config, opts);
  const start = p.lastIndexOf('### Last output');
  const tailBlock = p.slice(start, p.indexOf('## Report template'));
  assert.ok(Buffer.byteLength(tailBlock) >= 1500, 'at least the minimum tail survives: ' + Buffer.byteLength(tailBlock));
  assert.ok(tailBlock.includes('output line number 3999'), 'newest output kept');
});

test('redaction counts are singular for one value and include upstream redactions', () => {
  const oneSecret = { ...ctx, stackTrace: '', tail: 'boot\nAKIAABCDEFGHIJKLMNOP\ndone' };
  assert.ok(buildPrompt(oneSecret, config, opts).includes('## Crash context (1 value redacted)'));
  const withUpstream = buildPrompt({ ...oneSecret, redactions: 4 }, config, opts);
  assert.ok(withUpstream.includes('## Crash context (5 values redacted)'), 'redactions counted during capture are added');
});

test('a clean context leaves the crash-context heading bare', () => {
  const p = buildPrompt({ command: 'sh', cwd: '/tmp', tail: 'nothing secret here' }, {}, { reportPath: '/r.md' });
  assert.ok(p.includes('## Crash context\n\n- command:'), 'no redaction note when nothing was redacted');
  assert.ok(!/## Crash context \(/.test(p));
});

// --- Options ---------------------------------------------------------------

test('an explicit null testCommand means none, it does not fall back to the context', () => {
  // recovery.js always passes testCommand through; null there means "no test
  // command was resolved", and silently reusing ctx.testCommand would tell the
  // session to verify with a command phantom will never run.
  const p = buildPrompt(ctx, config, { ...opts, testCommand: null });
  assert.ok(p.includes('- test command: (none configured; see Phase 2)'));
  assert.ok(p.includes('(none; create one per Phase 2.2)'));
  assert.ok(!p.includes('`npm run test:unit`'), 'context test command not used');
});

test('attempt, maxAttempts and innerAttempts fall back and can be overridden', () => {
  const defaults = buildPrompt(ctx, config, { reportPath: '/r.md' });
  assert.ok(defaults.includes('Outer attempt: 1 of 3'), 'maxAttempts falls back to config.maxIterations');
  assert.ok(defaults.includes('Phase 4: 3.'), 'default inner attempts');
  const noConfig = buildPrompt(ctx, {}, { reportPath: '/r.md', innerAttempts: 7 });
  assert.ok(noConfig.includes('Outer attempt: 1 of 1'), 'falls back to a single attempt');
  assert.ok(noConfig.includes('Phase 4: 7.'), 'inner attempts honoured');
});

test('a fix run without a branch yet leaves the placeholder for phantom to fill', () => {
  const p = buildPrompt(ctx, config, { reportPath: '/r.md' });
  assert.ok(p.includes('{{branch}}'), 'branch left for phantom');
  assert.ok(p.includes('- Mode: **FIX** — you are on a dedicated branch;'), 'no dangling empty backticks');
  assert.equal(lineStarting(p, '| **Branch** |'), '| **Branch** | `{{branch}}` (from `main` @ `abc1234def`) |',
    'the report row falls back to the captured HEAD, truncated');
});

test('every phantom-filled placeholder is named and left unrendered', () => {
  const p = buildPrompt(ctx, config, opts);
  const note = p.slice(p.indexOf('## Report template'), p.indexOf('```markdown'));
  for (const key of PHANTOM_FILLS) {
    assert.ok(note.includes('{{' + key + '}}'), key + ' named in the instructions');
  }
  assert.ok(note.includes(VERIFICATION_MARKER));
  const rendered = p.slice(p.indexOf('```markdown'));
  for (const key of PHANTOM_FILLS) assert.ok(rendered.includes('{{' + key + '}}'), key + ' not rendered away');
});

test('loadSkill strips the YAML frontmatter but keeps the hard rules', () => {
  const s = loadSkill();
  assert.ok(!s.startsWith('---'), 'no leading frontmatter fence');
  assert.ok(!/^description:/m.test(s), 'no frontmatter keys');
  assert.ok(s.includes('## Hard rules (always)'), 'the rules themselves survive');
  assert.ok(fs.readFileSync(SKILL_PATH, 'utf8').startsWith('---'), 'the file really has frontmatter to strip');
});

test('buildResumePrompt bounds and redacts the feedback it echoes back', () => {
  // Short lines keep the blob well under the byte cap, so only the line trim can
  // drop the oldest ones -- the two limits are asserted separately below.
  const noisy = Array.from({ length: 400 }, (_, i) => 'n' + i).join('\n')
    + '\nAPI_KEY=sk-live-abcdefghijklmnopqrstuvwxyz\nnot ok 42 - final';
  assert.ok(Buffer.byteLength(noisy) < 8 * 1024, 'the fixture itself is under the byte cap');
  const p = buildResumePrompt(noisy, 1, 3, { testCommand: 'npm test' });
  assert.ok(!p.includes('sk-live-abcdefghijklmnopqrstuvwxyz'), 'secret redacted in the resume turn too');
  assert.ok(p.includes('not ok 42 - final'), 'the newest output survives');
  assert.ok(!p.includes('\nn0\n'), 'the oldest lines are trimmed');
  assert.ok(p.includes('\nn399\n'), 'the last 120 lines are kept');
  const huge = buildResumePrompt('x'.repeat(5 * 1024 * 1024) + '\nnot ok 1 - end', 1, 3);
  assert.ok(Buffer.byteLength(huge) < 14 * 1024, 'resume turn stays small: ' + Buffer.byteLength(huge));
  assert.ok(huge.includes('not ok 1 - end'), 'the newest output survives the byte trim');
  assert.ok(buildResumePrompt('', 1, 3).includes('(no output)'), 'empty feedback still renders');
});

test('buildClaudeArgs: turn limits, verbatim settings and omitted tool lists', () => {
  const fresh = buildClaudeArgs({ settings: {}, allowedTools: ['Read'], disallowedTools: ['WebFetch'] });
  assert.equal(DEFAULT_MAX_TURNS, 80, 'a silently smaller budget would strand recoveries mid-fix');
  assert.equal(RESUME_MAX_TURNS, 40);
  assert.equal(fresh[fresh.indexOf('--max-turns') + 1], '80', 'fresh sessions get the full budget');
  const pinned = buildClaudeArgs({ settings: {}, allowedTools: [], disallowedTools: [], resumeSessionId: 'x', maxTurns: 12 });
  assert.equal(pinned[pinned.indexOf('--max-turns') + 1], '12', 'explicit maxTurns wins over the resume default');
  const preSerialised = buildClaudeArgs({ settings: '{"permissions":{"deny":["Bash(rm *)"]}}' });
  assert.equal(preSerialised[preSerialised.length - 1], '{"permissions":{"deny":["Bash(rm *)"]}}', 'a string settings blob is passed through, not double-encoded');
  assert.ok(!preSerialised.includes('--allowedTools'), 'no empty tool flag');
  assert.ok(!preSerialised.includes('--disallowedTools'));
  assert.equal(fresh[fresh.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(!fresh.includes('--dangerously-skip-permissions'), 'never bypass permissions wholesale');
});

test('buildClaudeEnv defaults to the current environment', () => {
  const restore = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  try {
    const env = buildClaudeEnv();
    assert.ok(!('CLAUDECODE' in env), 'nested-session marker stripped from the inherited env');
    // process.env is case-insensitive on Windows, but a spread copy of it is a
    // plain object and is not: the key there is `Path`, so env.PATH is undefined.
    // That is fine for the real caller -- spawn resolves env names
    // case-insensitively on Windows -- so look the key up the way the copy holds it.
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    assert.ok(pathKey, 'a PATH survived the copy');
    assert.equal(env[pathKey], process.env.PATH, 'the rest of the environment is inherited');
  } finally {
    if (restore === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = restore;
  }
});
