'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const git = require('./git');
const { commandLineOf } = require('./context');
const { ensureExcluded } = git;
const ui = require('./ui');
const notify = require('./notify');
const announce = require('./announce');
const report = require('./report');
const prompt = require('./prompt');
const { isNeverTouch } = require('./never-touch');
const audit = require('./audit');
const { windowsSafeSpawn, killTree } = require('./watcher');
const { summarizeExit } = require('./crash');

const { log, colors } = ui;

const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const REPRO_TIMEOUT_MS = 30 * 1000;
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
  const probe = windowsSafeSpawn(bin, ['--version'], process.cwd(), process.env);
  const r = spawnSync(probe.file, probe.argv, { encoding: 'utf8', timeout: 15000, ...probe.opts });
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
  // Never `shell: true`: cmd.exe would re-split the argv, which shreds the
  // --settings JSON blob and splits an --allowedTools entry like
  // Bash(node --test test/x.js) across three slots. Only a .cmd/.bat claude
  // shim goes through cmd, with each argument escaped for it.
  const { file, argv, opts: winOpts } = windowsSafeSpawn(opts.bin, opts.args, opts.cwd, opts.env);
  const child = spawn(file, argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', opts.verbose ? 'inherit' : 'pipe'],
    ...winOpts,
  });
  const promise = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => { killTree(child, 'SIGKILL'); }, KILL_GRACE_MS);
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
 * Re-run the command that crashed, and say whether it still does.
 *
 * A green test suite is not proof the crash is gone: the tests that pass here
 * are usually the ones that were already passing while the command died, since
 * the bug was in a path they never covered. Only the original command can
 * answer the question the user actually has.
 *
 * A command that is still running at the cutoff counts as fixed. Long-lived
 * processes are the common case -- `phantom npm run dev` crashed on boot, and
 * surviving well past the point it used to die is exactly the evidence wanted.
 * Waiting for it to exit would hang the recovery forever.
 *
 * @returns {{ fixed: boolean, stillRunning: boolean, code: number|null, output: string }}
 */
function reproduce(ctx, { cwd, env, timeoutMs }) {
  const started = Date.now();
  const { file, argv, opts: winOpts } = windowsSafeSpawn(ctx.command, ctx.args || [], cwd, env);
  const r = spawnSync(file, argv, {
    cwd, env, encoding: 'utf8', timeout: Math.max(1000, timeoutMs),
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...winOpts,
  });
  const stillRunning = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
  return {
    fixed: stillRunning || r.status === 0,
    stillRunning,
    code: r.status,
    output: report.trimBytes(output, 4000),
    durationMs: Date.now() - started,
  };
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

const shortSha = (sha) => (sha ? String(sha).slice(0, 10) : '');

/**
 * The exact command that restores THIS stash, for a human to run.
 *
 * `apply`, not `pop`, and by sha. A bare `git stash pop` is only correct while
 * phantom's entry is still on top of the stack, which phantom cannot know --
 * the user's other shell, a `git pull --autostash`, or a second phantom run all
 * push entries of their own, and popping the wrong one overwrites the tree with
 * someone else's work. `git stash pop <sha>` is not the fix either: pop and
 * drop take only a `stash@{n}` reference and reject a raw commit
 * ("is not a stash reference"), so printing one would hand the user a command
 * that cannot run. `git stash apply <sha>` does accept the commit, is stable
 * however the stack moves, and leaves the entry in place until the user is
 * satisfied -- which is the safer default for someone recovering work anyway.
 */
const popHint = (s) => (s.stashRef ? 'git stash apply ' + shortSha(s.stashRef) : 'git stash pop');

/**
 * `stash@{n}` for `ref` right now, for the one message that has to name a
 * droppable reference. Recomputed at print time because n moves.
 */
const dropHint = (ref, opts) => {
  const i = git.stashIndexOf(ref, opts);
  return i === -1 ? 'git stash drop' : "git stash drop 'stash@{" + i + "}'";
};

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
    // The stash is tracked by commit sha and label, never by stack position:
    // `git stash pop` with no argument pops whatever landed on top, which may
    // belong to another shell or another phantom run. See git.stashPush.
    stashRef: null, stashLabel: null,
  };
  let iterations = 0;
  let testsPassed = null;
  const result = (status, message) => ({ status, branch: s.branch, reportPath: s.reportPath, iterations, testsPassed, message, sessionId: s.sessionId || null });

  /**
   * Give up *after* the stash was taken.
   *
   * `return result(...)` returns straight out of the try block without running
   * cleanup(), so every failure between the stash and step 9 used to orphan the
   * user's entire working tree -- stashed, unmentioned, and with the final
   * message naming an unrelated cause. Anything that bails past the stash point
   * has to come through here.
   */
  const bail = async (status, message) => {
    log.error(message);
    await cleanup('could not continue');
    return result(status, message);
  };

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
        killTree(child, 'SIGTERM');
        await waitForExit(child, KILL_GRACE_MS);
        if (child.exitCode === null && !child.signalCode) killTree(child, 'SIGKILL');
      }
      const opts = { cwd: s.root };
      if (s.done) {
        // Steps 6-9 already ran: the user is back on their branch (or chose to
        // stay on the phantom branch). Nothing to undo.
        log.warn('recovery ' + reason + ' after it finished; nothing to undo');
        return;
      }
      // Every step below reports whether it actually worked. The old code
      // discarded these booleans and then printed "working tree restored"
      // unconditionally -- so a reset blocked by a stale index.lock, or a
      // checkout refused because the branch is open in another worktree, was
      // announced as a successful restore while the user sat on the phantom
      // branch with a live stash and a half-written edit on disk.
      const failed = [];
      if (s.onPhantomBranch && s.baseSha) {
        if (!git.resetHard(s.baseSha, opts)) failed.push('discard the session\'s changes');
        if (!git.cleanUntracked(opts)) failed.push('remove the files it created');
      }
      if (s.onPhantomBranch && s.origRef) {
        if (git.checkout(s.origRef, opts)) {
          s.onPhantomBranch = false;
          if (s.branch && git.headSha(opts) === s.baseSha) { git.deleteBranch(s.branch, opts); s.branch = null; }
        } else {
          failed.push('return you to ' + s.origRef);
        }
      }
      if (s.stashed && !s.onPhantomBranch) {
        const pop = git.stashPop(s.stashRef, opts);
        if (pop.ok) s.stashed = false;
        else if (pop.conflicted) failed.push('restore your stash cleanly (it conflicted; resolve the markers, then `' + dropHint(s.stashRef, opts) + '`)');
        else failed.push('restore your stash (' + popHint(s) + ')');
      }
      if (!failed.length) {
        log.warn('recovery ' + reason + ': working tree restored');
      } else {
        log.error('recovery ' + reason + ', but phantom could not ' + failed.join('; could not '));
        if (s.onPhantomBranch && s.branch) log.error('you are still on ' + s.branch);
        if (s.stashed) log.error('your uncommitted work is safe in the stash: ' + popHint(s));
      }
    })();
    return s.cleanupPromise;
  };

  const abort = async (signal) => {
    s.aborted = true;
    await cleanup('interrupted by ' + signal);
    exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
  };
  const checkAborted = () => { if (s.aborted) throw new AbortedError(); };

  const installSignalHandlers = () => {
    // SIGHUP belongs here as much as the other two: closing a terminal tab or
    // dropping an SSH session sends it, and without a handler phantom died
    // silently mid-recovery, leaving the user on the phantom branch with a live
    // stash, no message, and an orphaned claude process. watcher.js has always
    // forwarded all three.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
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
        const ref = git.stashPush(label, opts);
        if (!ref) return result('error', 'could not stash the dirty tree');
        s.stashed = true;
        s.stashRef = ref;
        s.stashLabel = label;
        restoreHint = popHint(s);
        log.warn('stashed your uncommitted changes as "' + label + '"; restore with: ' + popHint(s));
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
    if (!s.baseSha) return await bail('refused', 'repository has no commits yet');
    if (!dryRun) {
      const name = 'phantom/fix-' + ctx.slug + '-' + Date.now().toString(36).slice(-5);
      if (!git.createBranch(name, opts)) return await bail('error', 'could not create branch ' + name);
      s.branch = name;
      s.onPhantomBranch = true;
      log.info('working on branch ' + colors.bold(name) + ' (your branch ' + s.origRef + ' is untouched)');
    }

    // 4-5. Claude session + independent verification loop
    const neverTouchBefore = audit.snapshotNeverTouch(s.root, config.neverTouch, { skipPrefixes: [phantomDir] });
    let testCommand = resolveTestCommand(s.root, config, ctx);
    const maxAttempts = Math.max(1, Number(config.maxIterations) || 1);
    const guard = { neverTouch: config.neverTouch, cwd: s.root, dryRun, testCommand, reportPath: s.reportPath };
    const guardJson = JSON.stringify(guard);
    // Windows cannot carry the payload in an env prefix, so it goes in a file
    // beside the reports (already git-excluded). Written only where it is used,
    // so nothing changes for macOS and Linux.
    let guardFilePath;
    if (process.platform === 'win32') {
      guardFilePath = path.join(reportDirAbs, '.guard.json');
      try { fs.writeFileSync(guardFilePath, guardJson); } catch { guardFilePath = undefined; }
    }
    const settings = prompt.buildSettings(config, guardJson, hooks.hookScriptPath || path.join(__dirname, 'guard-hook.js'), { warn: log.warn, guardFilePath });
    const allowedTools = prompt.buildAllowedTools(config, { dryRun, testCommand });
    const disallowedTools = prompt.buildDisallowedTools();
    const env = prompt.buildClaudeEnv(baseEnv);
    let sessionId = null;
    let lastClaude = null;
    let lastTest = null;
    let tokens = 0;
    let cached = 0;
    let repro = null;
    const reproTimeoutMs = Number(hooks.reproTimeoutMs) > 0 ? Number(hooks.reproTimeoutMs) : REPRO_TIMEOUT_MS;
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
      // The session prints nothing for minutes at a time; without a ticking
      // clock there is no way to tell work from a hang. Suppressed under
      // --verbose, where the session streams to the same stderr.
      const spin = ui.spinner(resuming ? 'claude is re-reading the failures' : 'claude is diagnosing and patching',
        flags.verbose ? { enabled: false } : {});
      let res;
      try { res = await run; } finally { spin.stop(); }
      s.child = null;
      checkAborted();
      lastClaude = res.json;
      tokens += report.sumTokens(res.json.usage);
      cached += report.cachedTokens(res.json.usage);
      if (res.timedOut) { timedOut = true; log.warn('claude session hit the ' + config.maxMinutes + ' minute cap'); break; }
      if (res.json.session_id) { sessionId = res.json.session_id; s.sessionId = sessionId; log.verbose('claude session ' + sessionId); }
      // .trim() before taking the first line. When claude fails before emitting
      // any JSON -- overwhelmingly the commonest first run, because the user has
      // not logged in yet -- finish() builds `result` as '' + '\n' + stderr, so
      // line 0 is the empty string. The user got "claude ended with an error:"
      // with nothing after it, phantom ran the test suite anyway, and then
      // blamed the session for making no changes. The one string that would
      // have told them what to do ("Invalid API key · Please run /login") was
      // sitting in line 1.
      if (res.json.is_error) {
        const why = String(res.json.result || res.json.subtype || '').trim().split('\n')[0].slice(0, 200);
        log.warn('claude ended with an error' + (why ? ': ' + why : ' and said nothing on stdout or stderr'));
      }
      log.verbose('claude turns=' + res.json.num_turns + ' tokens=' + report.sumTokens(res.json.usage) + ' subtype=' + res.json.subtype);
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
      // No spinner here: runTests is spawnSync, so it blocks the event loop and
      // the animation would freeze mid-frame -- worse than the static line above.
      const t = runTests(testCommand, { cwd: s.root, env: baseEnv, timeoutMs: Math.min(TEST_TIMEOUT_MS, Math.max(1000, deadline - Date.now())) });
      checkAborted();
      lastTest = t.output;
      testsPassed = t.passed;
      if (t.passed) {
        log.info(colors.green('tests pass'));
        if (config.verifyCommand !== false && !dryRun) {
          const cmd = commandLineOf(ctx);
          log.info('re-running the crashed command: ' + cmd + ' (up to ' + Math.round(reproTimeoutMs / 1000) + 's)…');
          repro = reproduce(ctx, { cwd: s.root, env: baseEnv, timeoutMs: reproTimeoutMs });
          if (repro.fixed) {
            log.info(colors.green(repro.stillRunning
              ? cmd + ' is still running after ' + Math.round(repro.durationMs / 1000) + 's — it no longer crashes'
              : cmd + ' now exits 0 — the crash is gone'));
          } else {
            log.warn(cmd + ' still exits ' + repro.code + '; the tests pass but the crash is not fixed');
          }
        }
        break;
      }
      log.warn('tests failed (exit ' + t.code + ')' + (t.timedOut ? ' — timed out' : ''));
      if (t.timedOut && deadline - Date.now() <= 0) { timedOut = true; break; }
      if (!sessionId) { log.warn('no session id returned; cannot resume'); break; }
    }
    checkAborted();

    // 6. Never-touch audit: git-visible changes plus a stat snapshot of
    // never-touch files git cannot see (a gitignored .env).
    let changedFiles = [];
    let violations = [];
    if (guardFilePath) { try { fs.unlinkSync(guardFilePath); } catch { /* already gone */ } }
    const snapDiff = audit.diffSnapshots(neverTouchBefore, audit.snapshotNeverTouch(s.root, config.neverTouch, { skipPrefixes: [phantomDir] }));
    // A tracked file that changed on disk is put back by the hard reset below,
    // so it is a violation but not a loss. Only a file git never knew about --
    // a gitignored .env is the usual one -- is beyond recovery, and saying
    // "phantom cannot restore this" about a file it just restored is a false
    // alarm on the most alarming message phantom has.
    const snapChanged = [...snapDiff.modified, ...snapDiff.added, ...snapDiff.removed];
    const unrestorable = snapChanged.filter((f) => !git.isTracked(f, opts));
    if (!dryRun) {
      changedFiles = git.changedFilesSince(s.baseSha, opts).filter((f) => !f.startsWith(phantomDir + '/'));
      violations = changedFiles.filter((f) => isNeverTouch(f, config.neverTouch));
    }
    for (const f of snapChanged) if (!violations.includes(f)) violations.push(f);
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
    // A session that changed nothing cannot have fixed anything, however green
    // the suite is: the tests that pass here are the ones that were already
    // passing while the command crashed.
    else if (testsPassed === true && changedFiles.length && (!repro || repro.fixed)) status = 'fixed';
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
      fixed: (repro ? 'fix verified by phantom: tests pass and the command no longer crashes' : 'fix verified by phantom')
        + '; your branch is unchanged',
      unfixed: !changedFiles.length
        ? 'the session made no changes; nothing was fixed'
        : repro && !repro.fixed
          ? 'tests pass but ' + commandLineOf(ctx) + ' still exits ' + repro.code
          : testsPassed === null ? 'patch could not be verified (no test run)' : 'tests still failing after ' + iterations + ' attempt(s)',
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
    const modelUsage = [modelUsed, report.formatTokens(tokens, cached)].filter(Boolean).join(' · ');
    md = report.renderTemplate(md, {
      iterations, duration: report.formatDuration(durationMs), modelUsage, status: report.statusBadge(status), session: report.sessionCell(sessionId),
      branch: reportBranch || '(none)', baseSha: s.baseSha.slice(0, 10), baseBranch: ctx.git.branch, reportPath: s.reportPath,
      command: commandLineOf(ctx), exitSummary: summarizeExit(ctx), generatedAt: new Date().toISOString(),
    });
    const claimsFixed = /\*\*Status:\*\*\s*✅/.test(md);
    if ((claimsFixed && status !== 'fixed') || status === 'error' || status === 'timeout') {
      md = md.replace(/\*\*Status:\*\*[^\n]*/, '**Status:** ' + report.statusBadge(status) + ' (set by phantom: ' + message + ')');
    }
    md = report.appendVerification(md, {
      status, testsPassed, testCommand, testOutput: lastTest, iterations, durationMs, tokens: tokens || null, cachedTokens: cached || null, changedFiles, sessionId, repro, command: commandLineOf(ctx),
      branch: reportBranch, baseSha: s.baseSha, baseBranch: ctx.git.branch, restoreHint, neverTouchViolations: violations,
    });
    fs.writeFileSync(s.reportPath, md);

    // 9. Restore the user's world
    if (s.onPhantomBranch) {
      if (git.isDirty(opts)) {
        s.stayed = true;
        const why = config.autoCommit === false ? '--no-commit'
          : violations.length ? 'never-touch violation, nothing was committed'
          : 'commit failed';
        log.warn('leaving you on ' + s.branch + ' with uncommitted changes (' + why + ')');
        // With a stash outstanding the old one-liner was actively destructive:
        // `git stash && git checkout <ref>` pushes phantom's work onto the stack,
        // so the `git stash pop` the user reaches for next restores THAT instead
        // of their own snapshot -- landing phantom's unverified patch on the
        // branch phantom just promised was untouched, and burying the real work
        // one level deeper. Popping by sha is what makes the sequence safe.
        log.warn(s.stashed
          ? 'go back with: git stash && git checkout ' + s.origRef + ' && ' + popHint(s)
          : 'go back with: git stash && git checkout ' + s.origRef);
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
      const pop = git.stashPop(s.stashRef, opts);
      if (pop.ok) { s.stashed = false; restoreHint = null; }
      else if (pop.conflicted) {
        // git has already written the merge into the tree and kept the entry on
        // the stack. Telling the user to "run git stash pop" here hands them a
        // command that cannot succeed, on a tree that is now carrying conflict
        // markers they were never told about.
        restoreHint = null;
        log.error('your stash conflicted with the restored tree; the working tree now has conflict markers');
        log.error('resolve them, then drop the stash with: ' + dropHint(s.stashRef, opts));
      } else {
        restoreHint = popHint(s);
        // `missing` means the entry left the stack while the session ran -- the
        // fake `drop-stash` case, another shell, a `git stash clear`. The commit
        // itself usually survives until gc, and `git stash apply <sha>` still
        // reaches it, which is the whole reason the sha is what gets recorded.
        log.warn(pop.missing
          ? 'your snapshot stash was dropped while phantom was working; the commit usually survives, so try: ' + popHint(s)
          : 'could not pop the stash automatically; run: ' + popHint(s));
      }
    }
    s.done = true;
    removeSignalHandlers();

    const final = result(status, message);
    // 10. Banner + webhook
    printBanner(final, { ctx, s, restoreHint: s.stashed ? restoreHint : null, durationMs, tokens, cached });
    try {
      const r = await notify.sendWebhook(config.webhook, notify.buildPayload(ctx, final));
      if (!r.skipped) log.verbose('webhook ' + (r.ok ? 'delivered' : 'failed: ' + (r.error || r.status)));
    } catch { /* best-effort */ }
    await announce.announceRecovery(ctx, config, final, s.root);
    // Asked last, so the webhook and the Claude Code briefing never wait on a human.
    await offerBranchDecision(final, { ctx, s, config, flags, opts });
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

/**
 * Offer to merge or delete the fix branch, right where the user is looking.
 *
 * Only when there is a real decision to make and it is safe to act on: a
 * verified fix, on a branch phantom actually left behind, with the user back
 * on their own branch and a clean tree. Anything else -- an unfixed run, a dry
 * run, a stash phantom could not pop, a non-interactive session -- falls
 * through silently and leaves the banner's git commands as the only path.
 * Declining is always free: the branch stays exactly as it is.
 */
async function offerBranchDecision(final, { ctx, s, config, flags, opts, ask = ui.ask }) {
  if (config.promptOnFinish === false || flags.noPrompt || flags.dryRun) return;
  if (final.status !== 'fixed' || !final.branch || s.stayed || s.stashed || s.onPhantomBranch) return;
  if (git.isDirty(opts)) return;

  const base = ctx.git.branch;
  const answer = await ask('merge into ' + colors.bold(base) + ', delete it, or keep it for later? '
    + colors.dim('[m/d/k]'), { keys: ['m', 'd', 'k'] });
  if (answer === null || answer === 'k') return;

  if (answer === 'd') {
    if (git.deleteBranch(final.branch, opts)) log.info('deleted ' + final.branch + '; ' + base + ' is unchanged');
    else log.warn('could not delete the branch; run: git branch -D ' + final.branch);
    return;
  }

  const merged = git.mergeBranch(final.branch, opts);
  if (merged.ok) {
    log.info(colors.green('merged ' + final.branch + ' into ' + base));
    log.info(colors.dim('undo with: git reset --hard ' + s.baseSha.slice(0, 10)));
    return;
  }
  // A conflict leaves the repo mid-merge. Say so plainly rather than unwinding
  // it: the user may want to resolve it, and --abort would discard that choice.
  log.warn('merge did not complete cleanly: ' + String(merged.stderr || '').trim().split('\n')[0]);
  log.warn('resolve it, or back out with: git merge --abort');
}

function printBanner(final, { ctx, s, restoreHint, durationMs, tokens, cached }) {
  const lines = [colors.bold('👻 phantom ' + describeStatus(final.status)) + colors.dim(' · ' + report.formatDuration(durationMs) + (tokens ? ' · ' + report.formatTokens(tokens, cached) : ''))];
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

module.exports = { runRecovery, runClaude, runTests, resolveClaudeBin, parseClaudeOutput, ensureExcluded, commitMessage, timestamp, offerBranchDecision, AbortedError };
