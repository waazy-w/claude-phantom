'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const git = require('./git');
const { ensureExcluded } = git;
const ui = require('./ui');
const notify = require('./notify');
const announce = require('./announce');
const report = require('./report');
const prompt = require('./prompt');
const { isNeverTouch } = require('./never-touch');
const audit = require('./audit');
const { summarizeExit } = require('./crash');

const { log, colors } = ui;

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const TEST_TAIL_BYTES = 64 * 1024;
const INSTALL_HINT = 'install Claude Code: npm install -g @anthropic-ai/claude-code (or set "claudeBin" in .phantomrc)';

/** @typedef {import('./context').CrashContext} CrashContext */
/** @typedef {import('./config').Config} Config */
/**
 * @typedef {object} RecoveryResult
 * @property {'fixed'|'unfixed'|'dry-run'|'aborted'|'refused'|'timeout'|'error'} status
 * @property {string|null} branch
 * @property {string|null} reportPath
 * @property {number} iterations
 * @property {boolean|null} testsPassed
 * @property {string} message
 */

class AbortedError extends Error {}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/**
 * @param {string} bin
 * @returns {{ ok: boolean, version?: string, error?: string }}
 */
function resolveClaudeBin(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' });
  if (r.error) return { ok: false, error: r.error.code === 'ENOENT' ? '"' + bin + '" not found on PATH' : String(r.error.message) };
  if (r.status !== 0) return { ok: false, error: '"' + bin + ' --version" exited ' + r.status + ': ' + String(r.stderr || '').trim() };
  return { ok: true, version: String(r.stdout || '').trim() };
}

function parseClaudeOutput(raw) {
  const text = String(raw || '').trim();
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return obj;
  } catch { /* fall through to line scan */ }
  const lines = text.split('\n').reverse();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && ('result' in obj || 'session_id' in obj)) return obj;
    } catch { /* not this line */ }
  }
  return { is_error: true, result: text.slice(-4000), subtype: 'unparsable_output' };
}

/**
 * Spawn one headless claude invocation. The prompt goes on stdin; JSON is read
 * from stdout. The returned promise carries `.child` for the kill switch.
 * @param {{ bin: string, args: string[], prompt: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, verbose?: boolean }} opts
 * @returns {Promise<{ json: object, raw: string, timedOut: boolean, exitCode: number|null, signal: string|null, durationMs: number }> & { child: import('node:child_process').ChildProcess }}
 */
function runClaude(opts) {
  const started = Date.now();
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', opts.verbose ? 'inherit' : 'pipe'],
    shell: process.platform === 'win32',
  });
  const promise = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS);
    }, Math.max(1, opts.timeoutMs));
    child.stdout.on('data', (c) => { stdout += c; });
    if (child.stderr) child.stderr.on('data', (c) => { stderr += c; });
    const finish = (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const json = parseClaudeOutput(stdout);
      if (json.subtype === 'unparsable_output' && stderr) json.result = (json.result || '') + '\n' + stderr.slice(-4000);
      resolve({ json, raw: stdout, timedOut, exitCode, signal, durationMs: Date.now() - started });
    };
    child.on('error', (err) => finish(null, err.code || String(err.message)));
    child.on('close', finish);
    child.stdin.on('error', () => { /* claude exited before reading; close handles it */ });
    child.stdin.end(opts.prompt);
  });
  promise.child = child;
  return promise;
}

/**
 * Phantom's own verification run (never trusts Claude's claim).
 * @returns {{ passed: boolean, output: string, code: number|null, timedOut: boolean }}
 */
function runTests(testCommand, { cwd, env, timeoutMs }) {
  const r = spawnSync(testCommand, {
    cwd, env, shell: true, encoding: 'utf8', timeout: Math.max(1000, timeoutMs), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  const combined = [r.stdout, r.stderr, r.error && !timedOut ? String(r.error.message) : ''].filter(Boolean).join('\n');
  return { passed: r.status === 0 && !r.error, output: report.trimBytes(combined, TEST_TAIL_BYTES), code: r.status, timedOut };
}

function phantomDirOf(reportDir) {
  const norm = reportDir.replace(/\\/g, '/').replace(/^\.\//, '');
  return norm.split('/')[0] || '.phantom';
}

function resolveTestCommand(root, config, ctx) {
  if (config.testCommand) return config.testCommand;
  if (ctx.testCommand) return ctx.testCommand;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.test) return 'npm test';
  } catch { /* no package.json */ }
  return null;
}

function commitMessage(ctx, status, reportRel, baseSha) {
  const subject = status === 'fixed' ? 'phantom: fix ' : 'phantom: WIP (' + status + ') ';
  const what = String(ctx.errorLine || summarizeExit(ctx)).replace(/\s+/g, ' ').trim().slice(0, 60);
  return subject + what + '\n\nAutomated ' + (status === 'fixed' ? 'fix' : 'attempt, NOT verified,') + ' by claude-phantom. Crash: ' + summarizeExit(ctx)
    + '\nReport: ' + reportRel + '\nBase: ' + baseSha;
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const t = setTimeout(resolve, ms);
    child.once('close', () => { clearTimeout(t); resolve(); });
  });
}

function describeStatus(status) {
  return {
    fixed: colors.green('✅ fixed'), unfixed: colors.yellow('❌ unfixed'), 'dry-run': colors.cyan('🔍 dry run'),
    aborted: colors.yellow('⚠ aborted'), refused: colors.yellow('⚠ refused'), timeout: colors.red('⏱ timeout'), error: colors.red('❌ error'),
  }[status] || status;
}

/**
 * Run the full recovery pipeline (design doc steps 1-10).
 * @param {CrashContext} ctx
 * @param {Config} config `maxMinutes` may be fractional here
 * @param {{ dryRun?: boolean, allowDirty?: boolean, verbose?: boolean }} [flags]
 * @param {{ exit?: (code: number) => void, onStart?: (ctl: { abort: (signal: string) => Promise<void>, cleanup: Function }) => void,
 *           env?: NodeJS.ProcessEnv, hookScriptPath?: string }} [hooks] test seams
 * @returns {Promise<RecoveryResult>}
 */
async function runRecovery(ctx, config, flags = {}, hooks = {}) {
  const t0 = Date.now();
  const dryRun = Boolean(flags.dryRun);
  const exit = hooks.exit || ((code) => process.exit(code));
  const baseEnv = hooks.env || process.env;
  const deadline = t0 + (Number(config.maxMinutes) || 15) * 60 * 1000;
  const s = {
    root: null, origRef: null, branch: null, baseSha: null, onPhantomBranch: false, stashed: false, child: null,
    reportPath: null, aborted: false, cleanupPromise: null, signalHandlers: [], stayed: false, done: false, sessionId: null,
  };
  let iterations = 0;
  let testsPassed = null;
  const result = (status, message) => ({ status, branch: s.branch, reportPath: s.reportPath, iterations, testsPassed, message, sessionId: s.sessionId || null });

  const removeSignalHandlers = () => {
    for (const [sig, h] of s.signalHandlers) process.removeListener(sig, h);
    s.signalHandlers = [];
  };

  /** Idempotent: kill claude, discard work on the phantom branch, restore the user's world. */
  const cleanup = (reason) => {
    if (s.cleanupPromise) return s.cleanupPromise;
    s.cleanupPromise = (async () => {
      removeSignalHandlers();
      const child = s.child;
      if (child && child.exitCode === null && !child.signalCode) {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        await waitForExit(child, KILL_GRACE_MS);
        if (child.exitCode === null && !child.signalCode) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }
      const opts = { cwd: s.root };
      if (s.done) {
        // Steps 6-9 already ran: the user is back on their branch (or chose to
        // stay on the phantom branch). Nothing to undo.
        log.warn('recovery ' + reason + ' after it finished; nothing to undo');
        return;
      }
      if (s.onPhantomBranch && s.baseSha) {
        git.resetHard(s.baseSha, opts);
        git.cleanUntracked(opts);
      }
      if (s.onPhantomBranch && s.origRef && git.checkout(s.origRef, opts)) {
        s.onPhantomBranch = false;
        if (s.branch && git.headSha(opts) === s.baseSha) { git.deleteBranch(s.branch, opts); s.branch = null; }
      }
      if (s.stashed && !s.onPhantomBranch && git.stashPop(opts)) s.stashed = false;
      log.warn('recovery ' + reason + ': working tree restored' + (s.stashed ? ' (run `git stash pop` to get your changes back)' : ''));
    })();
    return s.cleanupPromise;
  };

  const abort = async (signal) => {
    s.aborted = true;
    await cleanup('interrupted by ' + signal);
    exit(signal === 'SIGINT' ? 130 : 143);
  };
  const checkAborted = () => { if (s.aborted) throw new AbortedError(); };

  const installSignalHandlers = () => {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const h = () => { abort(sig); };
      process.on(sig, h);
      s.signalHandlers.push([sig, h]);
    }
  };
  if (hooks.onStart) hooks.onStart({ abort, cleanup });

  try {
    // 1. Preconditions
    if (!ctx.git || !ctx.git.root || !git.isRepo({ cwd: ctx.git.root })) {
      return result('refused', 'not a git repository; phantom only recovers inside git repos');
    }
    s.root = ctx.git.root;
    const opts = { cwd: s.root };
    // From here on every exit path goes through cleanup(): the stash taken
    // below and the branch created in step 3 must never be orphaned by Ctrl+C.
    installSignalHandlers();
    const bin = resolveClaudeBin(config.claudeBin || 'claude');
    if (!bin.ok) return result('error', 'claude CLI unavailable (' + bin.error + '); ' + INSTALL_HINT);
    log.verbose('claude: ' + bin.version);
    s.origRef = ctx.git.detached ? ctx.git.headSha : ctx.git.branch;
    const phantomDir = phantomDirOf(config.reportDir);
    ensureExcluded(s.root, phantomDir);
    let restoreHint = null;
    if (git.isDirty(opts)) {
      if (dryRun) {
        log.info('working tree is dirty; dry run reads it as-is');
      } else if (!flags.allowDirty) {
        return result('refused', 'working tree has uncommitted changes; commit/stash them or re-run with --allow-dirty');
      } else {
        const label = 'phantom-snapshot-' + timestamp();
        if (!git.stashPush(label, opts)) return result('error', 'could not stash the dirty tree');
        s.stashed = true;
        restoreHint = 'git stash pop';
        log.warn('stashed your uncommitted changes as "' + label + '"; restore with: git stash pop');
      }
    }

    // 2. Persist crash context
    const ts = timestamp();
    const reportDirAbs = path.resolve(s.root, config.reportDir);
    const crashDir = path.resolve(reportDirAbs, '..', 'crashes');
    fs.mkdirSync(crashDir, { recursive: true });
    fs.mkdirSync(reportDirAbs, { recursive: true });
    const crashPath = path.join(crashDir, ts + '-' + ctx.slug + '.json');
    fs.writeFileSync(crashPath, JSON.stringify(ctx, null, 2));
    s.reportPath = path.join(reportDirAbs, ts + '-' + ctx.slug + '.md');
    const reportRel = path.relative(s.root, s.reportPath).replace(/\\/g, '/');
    log.verbose('crash context saved to ' + path.relative(s.root, crashPath));

    // 3. Branch
    s.baseSha = git.headSha(opts);
    if (!s.baseSha) return result('refused', 'repository has no commits yet');
    if (!dryRun) {
      const name = 'phantom/fix-' + ctx.slug + '-' + Date.now().toString(36).slice(-5);
      if (!git.createBranch(name, opts)) return result('error', 'could not create branch ' + name);
      s.branch = name;
      s.onPhantomBranch = true;
      log.info('working on branch ' + colors.bold(name) + ' (your branch ' + s.origRef + ' is untouched)');
    }

    // 4-5. Claude session + independent verification loop
    const neverTouchBefore = audit.snapshotNeverTouch(s.root, config.neverTouch, { skipPrefixes: [phantomDir] });
    let testCommand = resolveTestCommand(s.root, config, ctx);
    const maxAttempts = Math.max(1, Number(config.maxIterations) || 1);
    const guard = { neverTouch: config.neverTouch, cwd: s.root, dryRun, testCommand, reportPath: s.reportPath };
    const settings = prompt.buildSettings(config, JSON.stringify(guard), hooks.hookScriptPath || path.join(__dirname, 'guard-hook.js'), { warn: log.warn });
    const allowedTools = prompt.buildAllowedTools(config, { dryRun, testCommand });
    const disallowedTools = prompt.buildDisallowedTools();
    const env = prompt.buildClaudeEnv(baseEnv);
    let sessionId = null;
    let lastClaude = null;
    let lastTest = null;
    let costUsd = 0;
    let timedOut = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      iterations = attempt;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { timedOut = true; break; }
      const resuming = attempt > 1 && sessionId;
      log.info(resuming
        ? 'tests still failing; resuming session with the output (attempt ' + attempt + '/' + maxAttempts + ')…'
        : (dryRun ? 'diagnosing (dry run)…' : 'diagnosing and patching…') + ' (attempt ' + attempt + '/' + maxAttempts + ', up to ' + Math.ceil(remaining / 60000) + ' min)');
      const text = resuming
        ? prompt.buildResumePrompt(lastTest, attempt, maxAttempts, { testCommand, reportPath: s.reportPath })
        : prompt.buildPrompt(ctx, config, { dryRun, reportPath: s.reportPath, attempt, maxAttempts, testCommand, branch: s.branch, baseSha: s.baseSha });
      const args = prompt.buildClaudeArgs({ settings, allowedTools, disallowedTools, model: config.model, resumeSessionId: resuming ? sessionId : null });
      const run = runClaude({ bin: config.claudeBin || 'claude', args, prompt: text, cwd: s.root, env, timeoutMs: remaining, verbose: Boolean(flags.verbose) });
      s.child = run.child;
      const res = await run;
      s.child = null;
      checkAborted();
      lastClaude = res.json;
      if (typeof res.json.total_cost_usd === 'number') costUsd += res.json.total_cost_usd;
      if (res.timedOut) { timedOut = true; log.warn('claude session hit the ' + config.maxMinutes + ' minute cap'); break; }
      if (res.json.session_id) { sessionId = res.json.session_id; s.sessionId = sessionId; log.verbose('claude session ' + sessionId); }
      if (res.json.is_error) log.warn('claude ended with an error: ' + String(res.json.result || res.json.subtype || '').split('\n')[0].slice(0, 200));
      log.verbose('claude turns=' + res.json.num_turns + ' cost=$' + (res.json.total_cost_usd || 0).toFixed(3) + ' subtype=' + res.json.subtype);
      const denials = Array.isArray(res.json.permission_denials) ? res.json.permission_denials : [];
      if (denials.length) {
        log.verbose(denials.length + ' tool call(s) denied by the guard/permission rules');
        for (const d of denials.slice(0, 10)) log.verbose('  denied ' + d.tool_name + ' ' + JSON.stringify(d.tool_input || {}).slice(0, 100));
      }
      if (dryRun) break;
      if (!testCommand) {
        testCommand = resolveTestCommand(s.root, config, ctx);
        if (!testCommand) { log.warn('no test command available; phantom cannot verify the patch'); break; }
      }
      log.info('running tests independently: ' + testCommand + ' (attempt ' + attempt + '/' + maxAttempts + ')…');
      const t = runTests(testCommand, { cwd: s.root, env: baseEnv, timeoutMs: Math.min(TEST_TIMEOUT_MS, Math.max(1000, deadline - Date.now())) });
      checkAborted();
      lastTest = t.output;
      testsPassed = t.passed;
      if (t.passed) { log.info(colors.green('tests pass')); break; }
      log.warn('tests failed (exit ' + t.code + ')' + (t.timedOut ? ' — timed out' : ''));
      if (t.timedOut && deadline - Date.now() <= 0) { timedOut = true; break; }
      if (!sessionId) { log.warn('no session id returned; cannot resume'); break; }
    }
    checkAborted();

    // 6. Never-touch audit: git-visible changes plus a stat snapshot of
    // never-touch files git cannot see (a gitignored .env).
    let changedFiles = [];
    let violations = [];
    const snapDiff = audit.diffSnapshots(neverTouchBefore, audit.snapshotNeverTouch(s.root, config.neverTouch, { skipPrefixes: [phantomDir] }));
    const unrestorable = [...snapDiff.modified, ...snapDiff.added, ...snapDiff.removed];
    if (!dryRun) {
      changedFiles = git.changedFilesSince(s.baseSha, opts).filter((f) => !f.startsWith(phantomDir + '/'));
      violations = changedFiles.filter((f) => isNeverTouch(f, config.neverTouch));
    }
    for (const f of unrestorable) if (!violations.includes(f)) violations.push(f);
    if (unrestorable.length) {
      log.error('never-touch files changed outside git during recovery: ' + unrestorable.join(', ') + ' — phantom cannot restore these; inspect them now');
    }
    if (violations.length && !dryRun) {
      log.error('never-touch violation: ' + violations.join(', ') + ' — discarding the session\'s changes');
      git.resetHard(s.baseSha, opts);
      git.cleanUntracked(opts);
      changedFiles = [];
    }
    let status;
    if (dryRun) status = 'dry-run';
    else if (violations.length) status = 'error';
    else if (timedOut) status = 'timeout';
    else if (testsPassed === true) status = 'fixed';
    else status = 'unfixed';

    // 7. Commit
    let committed = null;
    if (!dryRun && !violations.length && config.autoCommit !== false && changedFiles.length) {
      committed = git.commitAll(commitMessage(ctx, status, reportRel, s.baseSha), opts);
      if (committed) log.info((status === 'fixed' ? 'committed fix ' : 'committed WIP ') + committed.slice(0, 10) + ' on ' + s.branch);
      else log.warn('commit failed; changes remain uncommitted on ' + s.branch);
    }

    // 8. Report (a branch with no changes is removed in step 9; say so now)
    const durationMs = Date.now() - t0;
    const keepBranch = !dryRun && !s.stayed && Boolean(changedFiles.length || committed);
    const reportBranch = keepBranch ? s.branch : null;
    const messages = {
      fixed: 'fix verified by phantom; your branch is unchanged',
      unfixed: testsPassed === null ? 'patch could not be verified (no test run)' : 'tests still failing after ' + iterations + ' attempt(s)',
      'dry-run': 'diagnosis and proposed patch written to the report; nothing changed',
      timeout: 'recovery exceeded ' + config.maxMinutes + ' minute(s)',
      error: 'never-touch violation (' + violations.join(', ') + '); ' + (unrestorable.length ? 'inspect ' + unrestorable.join(', ') + ' — phantom cannot restore files git does not track' : 'branch reverted'),
    };
    const message = messages[status];
    let md = null;
    try { md = fs.readFileSync(s.reportPath, 'utf8'); } catch { /* Claude wrote nothing */ }
    if (!md || !md.trim()) {
      log.verbose('no report from claude; writing fallback');
      md = report.fallbackReport(ctx, { status, branch: reportBranch, reportPath: s.reportPath, iterations, message }, { claudeResult: lastClaude, testOutput: lastTest, baseSha: s.baseSha, durationMs });
    }
    const modelUsed = config.model || (lastClaude && lastClaude.modelUsage && Object.keys(lastClaude.modelUsage)[0]) || null;
    const modelCost = [modelUsed, report.formatCost(costUsd)].filter(Boolean).join(' · ');
    md = report.renderTemplate(md, {
      iterations, duration: report.formatDuration(durationMs), modelCost, status: report.statusBadge(status), session: report.sessionCell(sessionId),
      branch: reportBranch || '(none)', baseSha: s.baseSha.slice(0, 10), baseBranch: ctx.git.branch, reportPath: s.reportPath,
      command: [ctx.command, ...ctx.args].join(' '), exitSummary: summarizeExit(ctx), generatedAt: new Date().toISOString(),
    });
    const claimsFixed = /\*\*Status:\*\*\s*✅/.test(md);
    if ((claimsFixed && status !== 'fixed') || status === 'error' || status === 'timeout') {
      md = md.replace(/\*\*Status:\*\*[^\n]*/, '**Status:** ' + report.statusBadge(status) + ' (set by phantom: ' + message + ')');
    }
    md = report.appendVerification(md, {
      status, testsPassed, testCommand, testOutput: lastTest, iterations, durationMs, costUsd: costUsd || null, changedFiles, sessionId,
      branch: reportBranch, baseSha: s.baseSha, baseBranch: ctx.git.branch, restoreHint, neverTouchViolations: violations,
    });
    fs.writeFileSync(s.reportPath, md);

    // 9. Restore the user's world
    if (s.onPhantomBranch) {
      if (git.isDirty(opts)) {
        s.stayed = true;
        log.warn('leaving you on ' + s.branch + ' with uncommitted changes (--no-commit); go back with: git stash && git checkout ' + s.origRef);
      } else if (git.checkout(s.origRef, opts)) {
        s.onPhantomBranch = false;
        if (!changedFiles.length && !committed) {
          git.deleteBranch(s.branch, opts);
          log.verbose('deleted empty branch ' + s.branch);
          s.branch = null;
        }
      } else {
        log.error('could not check out ' + s.origRef + '; you are still on ' + s.branch);
      }
    }
    if (s.stashed && !s.onPhantomBranch) {
      if (git.stashPop(opts)) { s.stashed = false; restoreHint = null; }
      else log.warn('could not pop the stash automatically; run: git stash pop');
    }
    s.done = true;
    removeSignalHandlers();

    const final = result(status, message);
    // 10. Banner + webhook
    printBanner(final, { ctx, s, restoreHint: s.stashed ? restoreHint : null, durationMs, costUsd });
    try {
      const r = await notify.sendWebhook(config.webhook, notify.buildPayload(ctx, final));
      if (!r.skipped) log.verbose('webhook ' + (r.ok ? 'delivered' : 'failed: ' + (r.error || r.status)));
    } catch { /* best-effort */ }
    await announce.announceRecovery(ctx, config, final, s.root);
    return final;
  } catch (err) {
    if (err instanceof AbortedError || s.aborted) {
      await cleanup('aborted');
      return result('aborted', 'interrupted; working tree restored');
    }
    log.error('unexpected error: ' + (err && err.stack ? err.stack : err));
    await cleanup('failed');
    return result('error', 'internal error: ' + (err && err.message ? err.message : String(err)));
  } finally {
    removeSignalHandlers();
  }
}

function printBanner(final, { ctx, s, restoreHint, durationMs, costUsd }) {
  const lines = [colors.bold('👻 phantom ' + describeStatus(final.status)) + colors.dim(' · ' + report.formatDuration(durationMs) + (costUsd ? ' · ' + report.formatCost(costUsd) : ''))];
  lines.push(final.message);
  if (final.branch) {
    lines.push('');
    lines.push('branch  ' + colors.bold(final.branch) + (s.stayed ? colors.yellow(' (you are on it, uncommitted)') : ''));
    lines.push('review  ' + colors.cyan('git diff ' + ctx.git.branch + '..' + final.branch));
    lines.push('accept  ' + colors.cyan('git merge ' + final.branch));
    lines.push('reject  ' + colors.cyan('git branch -D ' + final.branch));
  }
  if (final.reportPath) {
    lines.push('');
    lines.push('report  ' + colors.cyan(path.relative(s.root, final.reportPath)));
  }
  if (final.sessionId) lines.push('session ' + colors.dim(final.sessionId + '  (claude --resume ' + final.sessionId + ')'));
  if (restoreHint) lines.push(colors.yellow('your stashed changes: ' + restoreHint));
  const color = final.status === 'fixed' ? colors.green : final.status === 'dry-run' ? colors.cyan : colors.yellow;
  ui.banner(lines, { color });
}

module.exports = { runRecovery, runClaude, runTests, resolveClaudeBin, parseClaudeOutput, ensureExcluded, commitMessage, timestamp, AbortedError };
