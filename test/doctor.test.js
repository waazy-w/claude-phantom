'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Writable } = require('node:stream');
const ui = require('../src/ui');
const { stripAnsi } = require('../src/ansi');
const { runDoctor, renderDoctor, parseAuthStatus } = require('../src/doctor');

const quiet = new Writable({ write(c, e, cb) { cb(); } });
ui.setStream(quiet);

// .native, because os.tmpdir() hands back an 8.3 short name on Windows while
// git reports the long form -- the same reason recovery.test.js does it.
const tmp = (prefix) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const sh = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function makeRepo({ commit = true, dirty = false, pkg = null } = {}) {
  const dir = tmp('phantom-doc-');
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 't@example.com']);
  sh(dir, ['config', 'user.name', 'tester']);
  sh(dir, ['config', 'core.autocrlf', 'false']);
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'initial']);
  }
  if (dirty) fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  return dir;
}

/** A home directory with exactly the Claude Code files a test asks for. */
function makeHome({ settings = null, installedPlugins = null } = {}) {
  const dir = tmp('phantom-home-');
  fs.mkdirSync(path.join(dir, '.claude', 'plugins'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  if (installedPlugins) fs.writeFileSync(path.join(dir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(installedPlugins));
  return dir;
}

/**
 * spawnSync-shaped stand-in for the claude binary. `auth` may be an object
 * (serialised as the --json payload), a raw string (to test the parser), or
 * 'unsupported' for a build that has no `auth` subcommand.
 */
function fakeClaude({ version = '2.1.239 (Claude Code)', auth = { loggedIn: true, authMethod: 'claude.ai' }, missing = false, versionExit = 0 } = {}) {
  const calls = [];
  const spawn = (file, argv, opts) => {
    calls.push({ file, argv, opts });
    if (missing) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
    if (argv[0] === '--version') return { status: versionExit, stdout: versionExit === 0 ? version + '\n' : '', stderr: versionExit === 0 ? '' : 'boom\n', error: null };
    if (argv[0] === 'auth') {
      if (auth === 'unsupported') return { status: 1, stdout: '', stderr: "error: unknown command 'auth'\n", error: null };
      if (typeof auth === 'string') return { status: 0, stdout: auth, stderr: '', error: null };
      return { status: auth.loggedIn ? 0 : 1, stdout: JSON.stringify(auth), stderr: '', error: null };
    }
    return { status: 127, stdout: '', stderr: 'unexpected argv: ' + argv.join(' '), error: null };
  };
  spawn.calls = calls;
  return spawn;
}

const whichOnly = (...names) => (bin) => (names.includes(bin) ? '/usr/local/bin/' + bin : null);

/** runDoctor with every seam filled, so nothing depends on the machine. */
function doctor(over = {}) {
  return runDoctor({
    cwd: over.cwd || makeRepo(),
    env: over.env || {},
    platform: over.platform || 'linux',
    home: over.home || makeHome(),
    spawn: over.spawn || fakeClaude(),
    which: over.which || whichOnly('git', 'npm'),
    overrides: over.overrides,
  });
}

const get = (result, name) => {
  const hit = result.checks.find((c) => c.name === name);
  assert.ok(hit, 'no check named ' + name + ' (have: ' + result.checks.map((c) => c.name).join(', ') + ')');
  return hit;
};

// ------------------------------------------------------------------- claude

test('a claude that is not on PATH fails with the install hint', () => {
  const r = doctor({ spawn: fakeClaude({ missing: true }) });
  const bin = get(r, 'claude binary');
  assert.equal(bin.status, 'fail');
  assert.match(bin.detail, /not found on PATH/);
  assert.match(bin.fix, /npm install -g @anthropic-ai\/claude-code/);
  assert.equal(r.ok, false);
  // The login probe must not invent an answer once the binary is unusable.
  assert.equal(get(r, 'claude login').status, 'warn');
  assert.match(get(r, 'claude login').detail, /not checked/);
});

test('a claude that exits non-zero on --version fails', () => {
  const r = doctor({ spawn: fakeClaude({ versionExit: 3 }) });
  assert.equal(get(r, 'claude binary').status, 'fail');
  assert.match(get(r, 'claude binary').detail, /exited 3/);
});

test('claudeBin from config is the binary that gets probed', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ claudeBin: '/opt/claude' }));
  const spawn = fakeClaude();
  const r = doctor({ cwd: dir, spawn });
  assert.ok(spawn.calls.every((c) => c.file === '/opt/claude'), 'probed ' + spawn.calls.map((c) => c.file).join(', '));
  assert.match(get(r, 'claude binary').detail, /claudeBin: \/opt\/claude/);
});

test('installed but not logged in is a failure, not a warning', () => {
  const r = doctor({ spawn: fakeClaude({ auth: { loggedIn: false } }) });
  const login = get(r, 'claude login');
  assert.equal(login.status, 'fail');
  assert.match(login.detail, /not logged in/);
  assert.match(login.fix, /auth login/);
  assert.equal(r.ok, false);
});

test('a logged-in claude reports how, but never who', () => {
  const r = doctor({
    spawn: fakeClaude({ auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'someone@example.com', orgName: 'Acme Inc', orgId: 'c3b2e507' } }),
  });
  const login = get(r, 'claude login');
  assert.equal(login.status, 'ok');
  assert.match(login.detail, /claude\.ai/);
  assert.match(login.detail, /max/);
  // Doctor output is written to be pasted into a bug report.
  assert.doesNotMatch(login.detail, /someone@example\.com/);
  assert.doesNotMatch(login.detail, /Acme Inc/);
  assert.doesNotMatch(login.detail, /c3b2e507/);
});

test('a third-party provider is named in the detail', () => {
  const r = doctor({ spawn: fakeClaude({ auth: { loggedIn: true, authMethod: 'apiKey', apiProvider: 'bedrock' } }) });
  assert.equal(get(r, 'claude login').status, 'ok');
  assert.match(get(r, 'claude login').detail, /bedrock/);
});

test('an update notice above the JSON does not read as logged out', () => {
  const noisy = 'New version available: 2.2.0\n' + JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\n';
  const r = doctor({ spawn: fakeClaude({ auth: noisy }) });
  assert.equal(get(r, 'claude login').status, 'ok');
});

test('parseAuthStatus returns null only when there is no JSON object at all', () => {
  assert.equal(parseAuthStatus('{"loggedIn":true}').loggedIn, true);
  assert.equal(parseAuthStatus('note\n{"loggedIn":false}\n').loggedIn, false);
  assert.equal(parseAuthStatus('error: unknown command'), null);
  assert.equal(parseAuthStatus(''), null);
  assert.equal(parseAuthStatus('[1,2]'), null);
});

test('a claude without `auth status` warns and says what was not established', () => {
  const r = doctor({ spawn: fakeClaude({ auth: 'unsupported' }) });
  const login = get(r, 'claude login');
  assert.equal(login.status, 'warn');
  assert.match(login.detail, /did NOT confirm/);
  assert.equal(r.ok, true);
});

test('an ANTHROPIC_API_KEY in the shell is called out, because it shadows the login', () => {
  const r = doctor({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' } });
  assert.match(get(r, 'claude login').detail, /ANTHROPIC_API_KEY/);
  // The value itself is never echoed back.
  assert.doesNotMatch(get(r, 'claude login').detail, /sk-ant-xxx/);
});

// ---------------------------------------------------------------------- git

test('outside a git repository the repo check fails and the rest stand down', () => {
  const r = doctor({ cwd: tmp('phantom-bare-') });
  assert.equal(get(r, 'git repository').status, 'fail');
  assert.match(get(r, 'git repository').detail, /not a git repository/);
  assert.match(get(r, 'git repository').fix, /git init/);
  assert.equal(get(r, 'git history').status, 'warn');
  assert.equal(get(r, 'working tree').status, 'warn');
  assert.equal(r.ok, false);
});

test('git missing from PATH is reported as git missing, not as "no repository"', () => {
  const r = doctor({ cwd: makeRepo(), which: whichOnly('npm') });
  assert.equal(get(r, 'git repository').status, 'fail');
  assert.match(get(r, 'git repository').detail, /git is not on PATH/);
});

test('a fresh git init fails on history with the one command that fixes it', () => {
  const r = doctor({ cwd: makeRepo({ commit: false }) });
  assert.equal(get(r, 'git repository').status, 'ok');
  const history = get(r, 'git history');
  assert.equal(history.status, 'fail');
  assert.match(history.detail, /no commits yet/);
  assert.match(history.fix, /git commit/);
  assert.equal(r.ok, false);
});

test('a repository with a commit reports the branch and the sha', () => {
  const dir = makeRepo();
  const r = doctor({ cwd: dir });
  const history = get(r, 'git history');
  assert.equal(history.status, 'ok');
  assert.match(history.detail, /^main at [0-9a-f]{10}$/);
  assert.equal(get(r, 'working tree').status, 'ok');
  assert.equal(get(r, 'working tree').detail, 'clean');
});

test('a detached HEAD is ok, and says phantom will return you to the sha', () => {
  const dir = makeRepo();
  sh(dir, ['checkout', '-q', '--detach', 'HEAD']);
  const history = get(doctor({ cwd: dir }), 'git history');
  assert.equal(history.status, 'ok');
  assert.match(history.detail, /^detached HEAD at [0-9a-f]{10}/);
  assert.match(history.detail, /not a branch/);
});

test('a dirty tree is a warning that names --allow-dirty', () => {
  const r = doctor({ cwd: makeRepo({ dirty: true }) });
  const tree = get(r, 'working tree');
  assert.equal(tree.status, 'warn');
  assert.match(tree.detail, /1 uncommitted change/);
  assert.match(tree.fix, /--allow-dirty/);
  // A dirty tree is normal; it must never make the whole report a failure.
  assert.equal(r.ok, true);
});

test('a linked worktree is reported as one', () => {
  const dir = makeRepo();
  const wt = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-wt-'))), 'linked');
  sh(dir, ['worktree', 'add', '-q', '-b', 'side', wt]);
  const r = doctor({ cwd: wt });
  assert.equal(get(r, 'git repository').status, 'ok');
  assert.match(get(r, 'git repository').detail, /linked worktree/);
});

test('a submodule is reported as one, with its superproject', () => {
  const parent = makeRepo();
  const child = makeRepo();
  // protocol.file.allow: git 2.38+ refuses file:// submodules without it.
  sh(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub']);
  const r = doctor({ cwd: path.join(parent, 'sub') });
  assert.equal(get(r, 'git repository').status, 'ok');
  assert.match(get(r, 'git repository').detail, /submodule of /);
});

// ------------------------------------------------------------- test command

test('the test command comes from package.json when config says nothing', () => {
  const r = doctor({ cwd: makeRepo({ pkg: { name: 'x', scripts: { test: 'node --test' } } }) });
  const t = get(r, 'test command');
  assert.equal(t.status, 'ok');
  assert.match(t.detail, /^npm test \(from package\.json/);
});

test('a configured test command wins and is checked against PATH', () => {
  const dir = makeRepo({ pkg: { name: 'x', scripts: { test: 'node --test' } } });
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ testCommand: 'pytest -q' }));
  const r = doctor({ cwd: dir });
  const t = get(r, 'test command');
  assert.equal(t.status, 'warn');
  assert.match(t.detail, /pytest -q \(from config\), but "pytest" is not on PATH/);
});

test('a configured test command that resolves is ok', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ testCommand: 'pytest -q' }));
  const r = doctor({ cwd: dir, which: whichOnly('git', 'pytest') });
  assert.equal(get(r, 'test command').status, 'ok');
});

test('a shell construct is not reported as a missing program', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ testCommand: 'CI=1 make test' }));
  const r = doctor({ cwd: dir });
  assert.equal(get(r, 'test command').status, 'ok');
});

test('no test command anywhere is a warning about verification', () => {
  const r = doctor({ cwd: makeRepo() });
  const t = get(r, 'test command');
  assert.equal(t.status, 'warn');
  assert.match(t.detail, /cannot verify the patch/);
});

// ------------------------------------------------------------ notifications

test('macOS without terminal-notifier says the AppleScript fallback is swallowed', () => {
  const r = doctor({ platform: 'darwin', which: whichOnly('git') });
  const n = get(r, 'notifications');
  assert.equal(n.status, 'warn');
  assert.match(n.detail, /AppleScript/);
  assert.match(n.detail, /silently/);
  assert.match(n.detail, /exits 0/);
  assert.match(n.fix, /brew install terminal-notifier/);
});

test('macOS with terminal-notifier is ok', () => {
  const r = doctor({ platform: 'darwin', which: whichOnly('git', 'terminal-notifier') });
  assert.equal(get(r, 'notifications').status, 'ok');
  assert.match(get(r, 'notifications').detail, /terminal-notifier at/);
});

test('linux needs notify-send', () => {
  assert.equal(get(doctor({ platform: 'linux', which: whichOnly('git') }), 'notifications').status, 'warn');
  assert.equal(get(doctor({ platform: 'linux', which: whichOnly('git', 'notify-send') }), 'notifications').status, 'ok');
});

test('an unsupported platform says notifications are skipped entirely', () => {
  const n = get(doctor({ platform: 'win32', which: whichOnly('git', 'terminal-notifier', 'notify-send') }), 'notifications');
  assert.equal(n.status, 'warn');
  assert.match(n.detail, /not supported on win32/);
});

test('the notification row says whether notify is currently on', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ notify: true }));
  const on = get(doctor({ cwd: dir, platform: 'darwin', which: whichOnly('git', 'terminal-notifier') }), 'notifications');
  assert.match(on.detail, /notify is on/);
  const off = get(doctor({ platform: 'darwin', which: whichOnly('git', 'terminal-notifier') }), 'notifications');
  assert.match(off.detail, /off until you pass --notify/);
});

// -------------------------------------------------- claude code integration

test('a status line that already runs phantom-status is ok', () => {
  const home = makeHome({ settings: { statusLine: { type: 'command', command: 'phantom-status' } } });
  const s = get(doctor({ home }), 'status line');
  assert.equal(s.status, 'ok');
  assert.match(s.detail, /phantom-status is wired/);
});

test('someone else\'s status line is a warning that points at the chaining example', () => {
  const home = makeHome({ settings: { statusLine: { type: 'command', command: '/usr/local/bin/starship-ish' } } });
  const s = get(doctor({ home }), 'status line');
  assert.equal(s.status, 'warn');
  assert.match(s.detail, /already runs a status line/);
  assert.match(s.fix, /statusline\.sh/);
});

test('no status line at all gets the settings.json snippet', () => {
  const s = get(doctor({ home: makeHome() }), 'status line');
  assert.equal(s.status, 'warn');
  assert.match(s.fix, /"statusLine".*phantom-status/);
});

test('a project .claude/settings.json counts as well as the user one', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ statusLine: { type: 'command', command: 'phantom-status' } }));
  assert.equal(get(doctor({ cwd: dir }), 'status line').status, 'ok');
});

test('the plugin is ok only when it is enabled', () => {
  const enabled = makeHome({ settings: { enabledPlugins: { 'phantom@claude-phantom': true } } });
  assert.equal(get(doctor({ home: enabled }), 'claude code plugin').status, 'ok');

  const installedOnly = makeHome({ installedPlugins: { version: 2, plugins: { 'phantom@claude-phantom': [{ scope: 'user' }] } } });
  const p = get(doctor({ home: installedOnly }), 'claude code plugin');
  assert.equal(p.status, 'warn');
  assert.match(p.detail, /installed but not enabled/);

  const none = get(doctor({ home: makeHome({ settings: { enabledPlugins: { 'other@x': true } } }) }), 'claude code plugin');
  assert.equal(none.status, 'warn');
  assert.match(none.fix, /plugin marketplace add waazy-w\/claude-phantom/);
});

// ------------------------------------------------------------------- config

test('an unparseable .phantomrc is a failure, and the other checks still run', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), '{ not json');
  const r = doctor({ cwd: dir });
  const cfg = get(r, 'config');
  assert.equal(cfg.status, 'fail');
  assert.match(cfg.detail, /could not parse \.phantomrc/);
  assert.match(cfg.detail, /refuses to run any command here/);
  assert.equal(r.ok, false);
  // The point of continuing: the user still learns everything else in one pass.
  assert.equal(get(r, 'claude binary').status, 'ok');
  assert.equal(get(r, 'git history').status, 'ok');
});

test('an invalid setting is a failure with the validator\'s own words', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ maxIterations: 99 }));
  const cfg = get(doctor({ cwd: dir }), 'config');
  assert.equal(cfg.status, 'fail');
  assert.match(cfg.detail, /maxIterations must be an integer between 1 and 10/);
});

test('config names the files it loaded', () => {
  const dir = makeRepo({ pkg: { name: 'x', phantom: { maxMinutes: 20 } } });
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ maxIterations: 2 }));
  const cfg = get(doctor({ cwd: dir }), 'config');
  assert.equal(cfg.status, 'ok');
  assert.match(cfg.detail, /\.phantomrc/);
  assert.match(cfg.detail, /package\.json/);
});

test('settings that are valid but self-defeating are warnings', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.phantomrc'), JSON.stringify({ maxMinutes: 2, webhook: 'http://example.com/hook', keepReports: 0 }));
  const cfg = get(doctor({ cwd: dir }), 'config');
  assert.equal(cfg.status, 'warn');
  assert.match(cfg.detail, /maxMinutes is 2/);
  assert.match(cfg.detail, /plain http/);
  assert.match(cfg.detail, /keepReports is 0/);
});

test('cli overrides reach the config the doctor reports on', () => {
  const r = doctor({ cwd: makeRepo(), overrides: { testCommand: 'pytest -q' } });
  assert.match(get(r, 'test command').detail, /pytest -q \(from config\)/);
});

// ------------------------------------------------------------------ overall

test('a healthy machine is all green and ok', () => {
  const home = makeHome({
    settings: { statusLine: { type: 'command', command: 'phantom-status' }, enabledPlugins: { 'phantom@claude-phantom': true } },
  });
  const r = doctor({
    cwd: makeRepo({ pkg: { name: 'x', scripts: { test: 'node --test' } } }),
    home,
    platform: 'darwin',
    which: whichOnly('git', 'npm', 'terminal-notifier'),
  });
  assert.deepEqual(r.checks.filter((c) => c.status !== 'ok').map((c) => c.name + ': ' + c.detail), []);
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 10);
  for (const c of r.checks) {
    assert.equal(typeof c.name, 'string');
    assert.ok(['ok', 'warn', 'fail'].includes(c.status));
    assert.equal(typeof c.detail, 'string');
    assert.ok(c.fix === null || typeof c.fix === 'string');
  }
});

test('warnings alone never sink the verdict', () => {
  const r = doctor({ cwd: makeRepo({ dirty: true }), platform: 'win32' });
  assert.ok(r.checks.some((c) => c.status === 'warn'));
  assert.equal(r.ok, true);
});

test('runDoctor never exits the process', () => {
  const real = process.exit;
  let called = false;
  process.exit = () => { called = true; };
  try {
    doctor({ cwd: tmp('phantom-bare-'), spawn: fakeClaude({ missing: true }) });
  } finally {
    process.exit = real;
  }
  assert.equal(called, false);
});

// ----------------------------------------------------------------- renderer

/** Phantom's own output, for the half of this command whose job is to say it. */
function render(result) {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  ui.setStream(s);
  try { renderDoctor(result); } finally { ui.setStream(quiet); }
  return stripAnsi(text);
}

test('the renderer prints every check, and the fix under the ones that need it', () => {
  const out = render({
    ok: false,
    checks: [
      { name: 'claude binary', status: 'ok', detail: '2.1.239', fix: null },
      { name: 'claude login', status: 'fail', detail: 'not logged in', fix: 'claude auth login' },
      { name: 'working tree', status: 'warn', detail: '3 uncommitted change(s)', fix: 'use --allow-dirty' },
    ],
  });
  assert.match(out, /claude binary\s+2\.1\.239/);
  assert.match(out, /claude login\s+not logged in/);
  assert.match(out, /↳ claude auth login/);
  assert.match(out, /↳ use --allow-dirty/);
  assert.match(out, /1 ok · 1 warning · 1 problem/);
  assert.match(out, /fix the ❌ rows above/);
});

test('a fix on a passing check is not printed as an instruction', () => {
  const out = render({ ok: true, checks: [{ name: 'config', status: 'ok', detail: 'defaults only', fix: 'do not do this' }] });
  assert.doesNotMatch(out, /do not do this/);
  assert.match(out, /phantom is ready/);
});

test('the verdict distinguishes ready-with-warnings from broken', () => {
  const warned = render({ ok: true, checks: [{ name: 'notifications', status: 'warn', detail: 'no terminal-notifier', fix: 'brew install terminal-notifier' }] });
  assert.match(warned, /phantom is ready/);
  assert.match(warned, /optional polish/);

  const broken = render({ ok: false, checks: [{ name: 'git repository', status: 'fail', detail: 'not a git repository', fix: 'git init' }] });
  assert.doesNotMatch(broken, /phantom is ready/);
  assert.doesNotMatch(broken, /optional polish/);
});

test('the renderer survives an empty result rather than throwing over the report', () => {
  assert.match(render({ ok: true, checks: [] }), /0 ok/);
  assert.doesNotThrow(() => render({}));
});
