'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { summarizeExit } = require('./crash');
const { redact } = require('./redact');
const { trimLines, trimBytes, loadTemplate, VERIFICATION_MARKER } = require('./report');

const SKILL_PATH = path.join(__dirname, '..', 'plugin', 'skills', 'crash-recovery', 'SKILL.md');
const CONTEXT_BYTE_BUDGET = 24 * 1024;
const TAIL_LINES = 200;
const MIN_TAIL_BYTES = 2048;
const DEFAULT_MAX_TURNS = 80;
const RESUME_MAX_TURNS = 40;
const DEFAULT_INNER_ATTEMPTS = 3;

/** Placeholders Claude must leave for phantom to fill after the session. */
const PHANTOM_FILLS = ['iterations', 'duration', 'modelCost', 'session'];

const BASH_DENY = [
  'Bash(git push *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git reset *)', 'Bash(git stash *)',
  'Bash(git rebase *)', 'Bash(git commit *)', 'Bash(git clean *)', 'Bash(git merge *)', 'Bash(git branch -D *)',
  'Bash(rm *)', 'Bash(rmdir *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(ssh *)', 'Bash(scp *)',
  'Bash(npm install *)', 'Bash(npm install)', 'Bash(npm i *)', 'Bash(npm ci *)', 'Bash(npm ci)', 'Bash(npm uninstall *)',
  'Bash(yarn add *)', 'Bash(pnpm add *)', 'Bash(pip install *)', 'Bash(npx prisma *)', 'Bash(sudo *)',
  'Bash(chmod -R *)', 'Bash(chown *)', 'Bash(docker *)', 'Bash(kubectl *)', 'Bash(pkill *)', 'Bash(killall *)',
];

/** @returns {string} SKILL.md body without its YAML frontmatter */
function loadSkill() {
  const raw = fs.readFileSync(SKILL_PATH, 'utf8');
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function fence(text, lang = 'text') {
  const body = String(text === null || text === undefined ? '' : text).replace(/```/g, '`​``');
  return '```' + lang + '\n' + body + '\n```';
}

function describeCommand(ctx) {
  return [ctx.command, ...(ctx.args || [])].join(' ');
}

function gitSection(ctx) {
  if (!ctx.git) return '- git: not a repository';
  const g = ctx.git;
  const lines = [
    '- branch: `' + g.branch + '`' + (g.detached ? ' (detached HEAD)' : '') + ' @ `' + String(g.headSha || '').slice(0, 10) + '`',
    '- dirty before recovery: ' + (g.dirty ? 'yes (stashed by phantom)' : 'no'),
  ];
  if (g.recentCommits && g.recentCommits.length) lines.push('- recent commits:\n' + fence(g.recentCommits.slice(0, 10).join('\n')));
  return lines.join('\n');
}

function pkgSection(ctx) {
  if (!ctx.pkg) return '- package.json: none found';
  const scripts = ctx.pkg.scripts || {};
  const keys = Object.keys(scripts);
  if (!keys.length) return '- package.json `' + (ctx.pkg.name || '') + '`: no scripts';
  return '- package.json `' + (ctx.pkg.name || '') + '` scripts:\n' + fence(keys.map((k) => k + ': ' + scripts[k]).join('\n'));
}

/**
 * Crash context block, trimmed so the tail fits inside CONTEXT_BYTE_BUDGET.
 * @returns {{ text: string, redactions: number }}
 */
function contextSection(ctx, testCommand) {
  const trace = redact(ctx.stackTrace || '');
  const tailRaw = redact(trimLines(ctx.tail || '', TAIL_LINES));
  const head = [
    '- command: `' + describeCommand(ctx) + '`',
    '- cwd: `' + ctx.cwd + '`',
    '- exit: ' + summarizeExit(ctx),
    '- error line: ' + (ctx.errorLine ? '`' + ctx.errorLine + '`' : '(none detected)'),
    '- files named in the trace: ' + (ctx.hintFiles && ctx.hintFiles.length ? ctx.hintFiles.map((f) => '`' + f + '`').join(', ') : '(none)'),
    '- test command: ' + (testCommand ? '`' + testCommand + '`' : '(none configured; see Phase 2)'),
    gitSection(ctx),
    pkgSection(ctx),
    '',
    '### Stack trace',
    fence(trace.text ? trimLines(trace.text, 60) : '(no stack trace extracted; see output below)'),
    '',
    '### Last output (stdout+stderr interleaved, newest last)',
  ].join('\n');
  const budget = Math.max(MIN_TAIL_BYTES, CONTEXT_BYTE_BUDGET - Buffer.byteLength(head, 'utf8') - 64);
  const tail = trimBytes(tailRaw.text, budget);
  const redactions = trace.redactions + tailRaw.redactions + (Number(ctx.redactions) || 0);
  const header = '## Crash context' + (redactions ? ' (' + redactions + ' value' + (redactions === 1 ? '' : 's') + ' redacted)' : '');
  return { text: header + '\n\n' + head + '\n' + fence(tail || '(no output captured)'), redactions };
}

/**
 * Full first-turn prompt for the headless session.
 * @param {import('./context').CrashContext} ctx
 * @param {import('./config').Config} config
 * @param {{ dryRun?: boolean, reportPath: string, attempt?: number, maxAttempts?: number, innerAttempts?: number,
 *           testCommand?: string|null, branch?: string|null, baseSha?: string|null }} opts
 * @returns {string}
 */
function buildPrompt(ctx, config, opts) {
  const dryRun = Boolean(opts.dryRun);
  const attempt = opts.attempt || 1;
  const maxAttempts = opts.maxAttempts || config.maxIterations || 1;
  const inner = opts.innerAttempts || DEFAULT_INNER_ATTEMPTS;
  const testCommand = opts.testCommand !== undefined ? opts.testCommand : ctx.testCommand;
  const neverTouch = config.neverTouch || [];
  const context = contextSection(ctx, testCommand);
  const template = loadTemplate();
  const vars = {
    status: dryRun ? '🔍 DRY RUN' : '{{status}}',
    command: describeCommand(ctx),
    exitSummary: summarizeExit(ctx),
    branch: opts.branch || (dryRun ? '(dry run: no branch)' : '{{branch}}'),
    baseSha: String(opts.baseSha || (ctx.git && ctx.git.headSha) || '').slice(0, 10),
    baseBranch: ctx.git ? ctx.git.branch : 'HEAD',
    reportPath: opts.reportPath,
    generatedAt: new Date().toISOString(),
    errorSummary: ctx.errorLine || summarizeExit(ctx),
    errorLine: ctx.errorLine || '(none detected)',
  };
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

  return [
    '# claude-phantom recovery session',
    '',
    'You are the autonomous recovery agent started by `phantom` after the command below crashed. Nobody is watching; there is no one to ask. Work only inside the repository at `' + (ctx.git ? ctx.git.root : ctx.cwd) + '`.',
    '',
    '- Mode: **' + (dryRun ? 'DRY RUN' : 'FIX') + '**' + (dryRun ? ' — no edits; propose the test and the patch as diffs inside the report.' : ' — you are on a dedicated branch' + (opts.branch ? ' `' + opts.branch + '`' : '') + '; phantom commits for you.'),
    '- Outer attempt: ' + attempt + ' of ' + maxAttempts + ' (phantom re-runs the test command itself after you finish and resumes you with the output if it fails).',
    '- Inner verification attempts allowed in Phase 4: ' + inner + '.',
    '- Report path (write with the Write tool, exactly this path): `' + opts.reportPath + '`',
    '- Test command phantom will run to verify: ' + (testCommand ? '`' + testCommand + '`' : '(none; create one per Phase 2.2)'),
    '- Never-touch paths (reads and writes are blocked): ' + neverTouch.map((g) => '`' + g + '`').join(', '),
    '',
    '## Procedure',
    '',
    loadSkill(),
    '',
    context.text,
    '',
    '## Report template',
    '',
    'Write the report to the report path following this template. Phantom already filled the metadata placeholders; leave `{{' + PHANTOM_FILLS.join('}}`, `{{') + '}}` and the `' + VERIFICATION_MARKER + '` marker exactly as they are — phantom fills them after you finish. Replace every other placeholder and every instruction comment with real content.',
    '',
    fence(rendered, 'markdown'),
    '',
    '## Begin',
    '',
    'Start with Phase 0. Read the files named in the trace before forming a hypothesis. Finish by writing the report and a three-line summary (status, files changed, root cause).',
  ].join('\n');
}

/**
 * Short follow-up used with `--resume` when phantom's own test run failed.
 * @param {string} testFeedback combined test output
 * @param {number} attempt
 * @param {number} maxAttempts
 * @param {{ testCommand?: string|null, reportPath?: string|null }} [opts]
 * @returns {string}
 */
function buildResumePrompt(testFeedback, attempt, maxAttempts, opts = {}) {
  const output = redact(trimBytes(trimLines(testFeedback || '(no output)', 120), 12 * 1024)).text;
  return [
    '# Verification failed — attempt ' + attempt + ' of ' + maxAttempts,
    '',
    'Phantom ran ' + (opts.testCommand ? '`' + opts.testCommand + '`' : 'the test command') + ' independently after your last turn and it did NOT pass. Output:',
    '',
    fence(output),
    '',
    'Re-read the failing output, revisit your root-cause hypothesis (Phase 1), and change the PATCH — never the test expectations. All hard rules still apply. Then run the test command yourself (Phase 4), update the report' + (opts.reportPath ? ' at `' + opts.reportPath + '`' : '') + ' with the new diff and status, keep the verification marker, and finish with the three-line summary.',
    attempt >= maxAttempts ? '\nThis is the last attempt. If it fails, set the status to ❌ UNFIXED and describe precisely what is still wrong.' : '',
  ].join('\n');
}

/**
 * `--allowedTools` rules for the session.
 * @param {import('./config').Config} config
 * @param {{ dryRun?: boolean, testCommand?: string|null }} opts
 * @returns {string[]}
 */
function buildAllowedTools(config, opts = {}) {
  const testCommand = opts.testCommand || config.testCommand;
  const tools = ['Read', 'Grep', 'Glob'];
  if (!opts.dryRun) tools.push('Edit', 'MultiEdit');
  tools.push('Write');
  if (testCommand) tools.push('Bash(' + testCommand + ')', 'Bash(' + testCommand + ' *)');
  tools.push(
    'Bash(npm test)', 'Bash(npm test *)', 'Bash(npm run test *)', 'Bash(npx vitest *)', 'Bash(npx jest *)', 'Bash(npx mocha *)',
    'Bash(node *)', 'Bash(node --test *)', 'Bash(git diff *)', 'Bash(git diff)', 'Bash(git log *)', 'Bash(git status)', 'Bash(git status *)',
    'Bash(git show *)', 'Bash(ls)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(pwd)',
  );
  return [...new Set(tools)];
}

/** @returns {string[]} `--disallowedTools` rules */
function buildDisallowedTools() {
  return [
    'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit',
    'Bash(git push *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git reset *)', 'Bash(git stash *)',
    'Bash(git rebase *)', 'Bash(git commit *)', 'Bash(git clean *)', 'Bash(rm *)', 'Bash(curl *)', 'Bash(wget *)',
    'Bash(npm install *)', 'Bash(npm i *)', 'Bash(npm ci *)', 'Bash(npx prisma *)', 'Bash(sudo *)',
  ];
}

function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Inline `--settings` object: deny rules for every never-touch glob plus the
 * guard hook on PreToolUse (skipped on win32, where the shell quoting differs).
 * @param {import('./config').Config} config
 * @param {string} guardEnvJson JSON for PHANTOM_GUARD
 * @param {string} [hookScriptPath]
 * @param {{ platform?: string, warn?: (msg: string) => void }} [opts]
 * @returns {{ permissions: { deny: string[] }, hooks?: object }}
 */
function buildSettings(config, guardEnvJson, hookScriptPath = path.join(__dirname, 'guard-hook.js'), opts = {}) {
  const deny = [];
  for (const glob of config.neverTouch || []) {
    for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob']) deny.push(tool + '(' + glob + ')');
  }
  deny.push(...BASH_DENY);
  const settings = { permissions: { deny: [...new Set(deny)] } };
  const platform = opts.platform || process.platform;
  if (platform === 'win32') {
    if (opts.warn) opts.warn('guard hook skipped on Windows; relying on permission rules only');
    return settings;
  }
  const command = 'PHANTOM_GUARD=' + shellSingleQuote(guardEnvJson) + ' ' + shellSingleQuote(process.execPath) + ' ' + shellSingleQuote(hookScriptPath);
  settings.hooks = {
    PreToolUse: [{
      matcher: 'Bash|Edit|Write|MultiEdit|Read|NotebookEdit|Grep|Glob',
      hooks: [{ type: 'command', command, timeout: 10 }],
    }],
  };
  return settings;
}

/**
 * argv for `spawn(claudeBin, args)` (no shell). The prompt goes on stdin.
 * @param {{ settings: object|string, allowedTools: string[], disallowedTools: string[], model?: string|null,
 *           resumeSessionId?: string|null, maxTurns?: number }} opts
 * @returns {string[]}
 */
function buildClaudeArgs(opts) {
  // project,local only: user-level hooks, allows, and env must not leak into the
  // recovery session (a global PreToolUse hook that rewrites commands would
  // otherwise trip the allowlist). Phantom's own --settings still apply.
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--setting-sources', 'project,local'];
  args.push('--max-turns', String(opts.maxTurns || (opts.resumeSessionId ? RESUME_MAX_TURNS : DEFAULT_MAX_TURNS)));
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.allowedTools && opts.allowedTools.length) args.push('--allowedTools', ...opts.allowedTools);
  if (opts.disallowedTools && opts.disallowedTools.length) args.push('--disallowedTools', ...opts.disallowedTools);
  args.push('--settings', typeof opts.settings === 'string' ? opts.settings : JSON.stringify(opts.settings));
  return args;
}

/** Environment for the claude child: inherits, minus nested-session markers. */
function buildClaudeEnv(base = process.env) {
  const env = { ...base };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

module.exports = {
  buildPrompt, buildResumePrompt, buildAllowedTools, buildDisallowedTools, buildSettings, buildClaudeArgs, buildClaudeEnv,
  loadSkill, shellSingleQuote, PHANTOM_FILLS, CONTEXT_BYTE_BUDGET, SKILL_PATH, DEFAULT_MAX_TURNS, RESUME_MAX_TURNS,
};
