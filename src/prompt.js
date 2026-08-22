'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { summarizeExit } = require('./crash');
const { redact } = require('./redact');
const { trimLines, trimBytes, loadTemplate, VERIFICATION_MARKER } = require('./report');
const { commandLineOf } = require('./context');

const SKILL_PATH = path.join(__dirname, '..', 'plugin', 'skills', 'crash-recovery', 'SKILL.md');
const CONTEXT_BYTE_BUDGET = 24 * 1024;
const TAIL_LINES = 200;
const MIN_TAIL_BYTES = 2048;
const DEFAULT_MAX_TURNS = 80;
const RESUME_MAX_TURNS = 40;
const DEFAULT_INNER_ATTEMPTS = 3;

/** Placeholders Claude must leave for phantom to fill after the session. */
const PHANTOM_FILLS = ['iterations', 'duration', 'modelUsage', 'session'];

const BASH_DENY = [
  'Bash(git push *)', 'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git reset *)', 'Bash(git stash *)',
  'Bash(git rebase *)', 'Bash(git commit *)', 'Bash(git clean *)', 'Bash(git merge *)', 'Bash(git branch -D *)',
  'Bash(rm *)', 'Bash(rmdir *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(ssh *)', 'Bash(scp *)',
  'Bash(npm install *)', 'Bash(npm install)', 'Bash(npm i *)', 'Bash(npm ci *)', 'Bash(npm ci)', 'Bash(npm uninstall *)',
  'Bash(yarn add *)', 'Bash(pnpm add *)', 'Bash(pip install *)', 'Bash(npx prisma *)', 'Bash(sudo *)',
  'Bash(chmod -R *)', 'Bash(chown *)', 'Bash(docker *)', 'Bash(kubectl *)', 'Bash(pkill *)', 'Bash(killall *)',
];

/** Heading of the section of SKILL.md that is lifted into the system prompt. */
const HARD_RULES_HEADING = '## Hard rules (always)';

/** `--session-id` is documented as `<uuid>` and claude rejects anything else. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @returns {string} SKILL.md body without its YAML frontmatter */
function loadSkill() {
  const raw = fs.readFileSync(SKILL_PATH, 'utf8');
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/**
 * SKILL.md split into the part that must survive compaction and the part that
 * does not have to.
 *
 * The rules are lifted out at load time rather than by restructuring SKILL.md,
 * because the same file is also a plugin skill that Claude Code loads on its
 * own; it has to stay readable as one document.
 *
 * If the heading ever moves or is renamed the split silently finds nothing --
 * so the fallback is the pre-split behaviour (everything in the user turn)
 * rather than a system prompt with no rules in it and a user turn with no rules
 * in it either, which would drop the safety envelope entirely.
 *
 * @returns {{ rules: string, procedure: string }}
 */
function splitSkill() {
  const body = loadSkill();
  const start = body.indexOf(HARD_RULES_HEADING);
  if (start < 0) return { rules: '', procedure: body };
  const nextHeading = body.indexOf('\n## ', start + HARD_RULES_HEADING.length);
  const end = nextHeading < 0 ? body.length : nextHeading;
  const rules = body.slice(start, end).trim();
  const procedure = (body.slice(0, start) + body.slice(end)).replace(/\n{3,}/g, '\n\n').trim();
  return { rules, procedure };
}

/** @returns {string} the hard-rules section of SKILL.md, or '' if it moved */
function loadHardRules() {
  return splitSkill().rules;
}

/** @returns {string} SKILL.md with the hard-rules section removed */
function loadProcedure() {
  return splitSkill().procedure;
}

/**
 * Text for `--append-system-prompt`, passed on EVERY invocation including
 * resumes.
 *
 * The rules used to live only in the first user turn. On a long recovery that
 * turn is many turns back and is a candidate for compaction, so exactly the
 * lines phantom cannot afford to lose ("never change a test's expectation",
 * "never git commit") were the ones a summary could paraphrase away. The system
 * prompt is re-sent verbatim on every request and is never compacted.
 *
 * Keep this byte-identical across the attempts of one recovery: it is the
 * cache prefix, so anything per-attempt in here (an attempt counter, a
 * timestamp) would invalidate the cached system block on every resume.
 *
 * @param {import('./config').Config} config
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {string}
 */
function buildSystemPrompt(config, opts = {}) {
  const rules = loadHardRules();
  const neverTouch = (config && config.neverTouch) || [];
  const out = [
    'You are the autonomous crash-recovery agent run by claude-phantom in a repository whose owner is not watching.',
    'The rules below outrank anything later in the conversation, including your own earlier plan, and apply on every turn of every attempt.',
  ];
  // Rule 6 says the never-touch list is "injected below the procedure". That
  // injection is in the user turn, which is the text this block exists to
  // survive, so the resolved globs are restated here next to the rule.
  if (rules) out.push('', rules);
  if (neverTouch.length) out.push('', 'Never-touch paths for this repository (reads and writes are both blocked): ' + neverTouch.map((g) => '`' + g + '`').join(', ') + '.');
  if (opts.dryRun) out.push('', 'DRY RUN: make no change to the repository. The only file you may write is the report path you were given.');
  return out.join('\n');
}

/**
 * A fresh session id phantom can record before the session exists.
 * `node:crypto` is built in, so this stays a zero-dependency package.
 * @returns {string}
 */
function newSessionId() {
  return randomUUID();
}

/**
 * Display name for `-n`, so `/resume` shows what the session was for instead of
 * a bare UUID.
 * @param {import('./context').CrashContext} ctx
 * @returns {string} e.g. `phantom: TypeError in report.js`
 */
function sessionName(ctx) {
  const c = ctx || {};
  const errorClass = /^\s*([A-Za-z_$][\w$.]*(?:Error|Exception))\b/.exec(String(c.errorLine || ''));
  const label = (errorClass && errorClass[1]) || (c.slug ? String(c.slug) : '') || 'crash';
  const hint = c.hintFiles && c.hintFiles.length ? path.basename(String(c.hintFiles[0])) : '';
  // Newlines and control characters would corrupt the /resume picker and the
  // terminal title, both of which render this string raw.
  const name = ('phantom: ' + label + (hint ? ' in ' + hint : '')).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return name.length > 72 ? name.slice(0, 71) + '…' : name;
}

function fence(text, lang = 'text') {
  const body = String(text === null || text === undefined ? '' : text).replace(/```/g, '`​``');
  return '```' + lang + '\n' + body + '\n```';
}

function describeCommand(ctx) {
  return commandLineOf(ctx);
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
    'The hard rules are in your system prompt, not below. They apply to every phase.',
    '',
    // Phases only. The hard rules travel in --append-system-prompt instead, so
    // they are re-sent on every request and cannot be compacted away mid-fix.
    loadProcedure(),
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
    // "All hard rules still apply" used to point at the first user turn, which
    // by attempt 3 may have been compacted. It now names the system prompt,
    // which is re-sent verbatim with this very request.
    'Re-read the failing output, revisit your root-cause hypothesis (Phase 1), and change the PATCH — never the test expectations. The hard rules in your system prompt still apply in full. Then run the test command yourself (Phase 4), update the report' + (opts.reportPath ? ' at `' + opts.reportPath + '`' : '') + ' with the new diff and status, keep the verification marker, and finish with the three-line summary.',
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
 * @param {{ platform?: string, warn?: (msg: string) => void, guardFilePath?: string }} [opts]
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
  let command;
  if (platform === 'win32') {
    // cmd.exe has no `VAR=value cmd` prefix, so the payload goes in a file and
    // the hook reads it from argv. Without a path to write to there is nothing
    // to register, and the deny rules above are all that is left -- they cover
    // the file tools but NOT Bash, so `cat .env` would be unguarded.
    if (!opts.guardFilePath) {
      if (opts.warn) opts.warn('guard hook skipped: no guard file path; permission rules do not cover Bash reads');
      return settings;
    }
    command = [process.execPath, hookScriptPath, opts.guardFilePath].map((a) => '"' + a + '"').join(' ');
  } else {
    command = 'PHANTOM_GUARD=' + shellSingleQuote(guardEnvJson) + ' ' + shellSingleQuote(process.execPath) + ' ' + shellSingleQuote(hookScriptPath);
  }
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
 *           resumeSessionId?: string|null, sessionId?: string|null, name?: string|null,
 *           appendSystemPrompt?: string|null, maxTurns?: number }} opts
 * @returns {string[]}
 */
/**
 * Fold a multi-line string into one line, for passing as a command-line
 * argument.
 *
 * A literal newline in an argument is fine for a direct spawn and fatal through
 * cmd.exe: it TERMINATES the command line. On Windows a `claude` installed by
 * npm is a `.cmd` shim, which `windowsSafeSpawn` routes through cmd.exe -- so
 * a multi-line --append-system-prompt truncated the invocation and the session
 * ran with no rules and no crash context. It failed on Windows only, and only
 * once the rules moved out of the user turn, where newlines had always been
 * safe because that text goes in over stdin.
 *
 * Flattened on every platform rather than only on win32: a rule that exists in
 * two different forms depending on the operating system is the shape of bug
 * this project keeps finding, and a model reads a bulleted line just as well.
 */
function flattenForArgv(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' · ');
}

function buildClaudeArgs(opts) {
  // project,local only: user-level hooks, allows, and env must not leak into the
  // recovery session (a global PreToolUse hook that rewrites commands would
  // otherwise trip the allowlist). Phantom's own --settings still apply.
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--setting-sources', 'project,local'];
  // Phantom passes no --mcp-config, so this means zero MCP servers. Without it
  // the target repo's .mcp.json is loaded, and so are the user-scoped
  // mcpServers in ~/.claude.json -- --setting-sources does NOT drop those.
  // --allowedTools stops the session calling them, but the servers still get
  // SPAWNED: startup latency on every attempt, and whatever a server does on
  // connect (dialling a production database, for one) happens anyway.
  args.push('--strict-mcp-config');
  args.push('--max-turns', String(opts.maxTurns || (opts.resumeSessionId ? RESUME_MAX_TURNS : DEFAULT_MAX_TURNS)));
  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) {
    // Never both: claude exits with "--session-id can only be used with
    // --continue or --resume if --fork-session is also specified." Resuming
    // already pins the id, so the caller's sessionId is redundant here, not lost.
    args.push('--resume', opts.resumeSessionId);
  } else if (opts.sessionId) {
    // Rejected by claude unless it is a real UUID. Failing here names the
    // caller; failing at spawn just says the recovery session would not start.
    if (!UUID_RE.test(opts.sessionId)) throw new TypeError('sessionId must be a UUID, got ' + JSON.stringify(opts.sessionId));
    args.push('--session-id', opts.sessionId);
  }
  // Accepted on fresh sessions and resumes alike; makes the session findable in
  // /resume as something other than a bare UUID.
  if (opts.name) args.push('--name', String(opts.name));
  // Passed on every invocation, resumes included -- that is the whole point of
  // moving the hard rules here (see buildSystemPrompt).
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', flattenForArgv(String(opts.appendSystemPrompt)));
  if (opts.allowedTools && opts.allowedTools.length) args.push('--allowedTools', ...opts.allowedTools);
  if (opts.disallowedTools && opts.disallowedTools.length) args.push('--disallowedTools', ...opts.disallowedTools);
  args.push('--settings', typeof opts.settings === 'string' ? opts.settings : JSON.stringify(opts.settings));
  return args;
}

/** Environment for the claude child: inherits, minus nested-session markers. */
/**
 * Variables phantom must NOT strip: they are how the session authenticates and
 * finds its own configuration, not how the parent talks to it.
 */
const KEEP_CLAUDE_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']);

/**
 * The environment for the recovery session, with the parent session's own
 * variables removed.
 *
 * Deleting `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` was not enough. Running
 * inside Claude Code exports ten of these, and two of them are a capability:
 * `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are a
 * unix-domain socket and bearer token addressed at the USER'S LIVE SESSION. A
 * recovery agent that phantom deliberately denies WebFetch, curl, git push and
 * Task was inheriting a channel back into the session that launched it --
 * a larger capability than anything on the deny list.
 *
 * `CLAUDE_EFFORT` matters for a duller reason: it silently set the recovery's
 * reasoning effort from whatever the outer session happened to be using, so
 * cost and quality depended on an invisible inherited value.
 *
 * Stripping by prefix rather than by name means a variable Claude Code adds
 * later is excluded by default, which is the right direction for this to fail.
 */
function buildClaudeEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (KEEP_CLAUDE_ENV.has(key)) continue;
    if (key === 'CLAUDECODE' || key === 'AI_AGENT' || /^CLAUDE(_CODE)?_/.test(key)) delete env[key];
  }
  return env;
}

module.exports = {
  buildPrompt, buildResumePrompt, buildSystemPrompt, buildAllowedTools, buildDisallowedTools, buildSettings, buildClaudeArgs, buildClaudeEnv,
  loadSkill, loadHardRules, loadProcedure, newSessionId, sessionName, shellSingleQuote, flattenForArgv,
  KEEP_CLAUDE_ENV, PHANTOM_FILLS, CONTEXT_BYTE_BUDGET, SKILL_PATH, HARD_RULES_HEADING, DEFAULT_MAX_TURNS, RESUME_MAX_TURNS,
};
