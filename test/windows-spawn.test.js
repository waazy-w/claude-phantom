'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { escapeArgForCmd, resolveWindowsCommand, windowsSafeSpawn } = require('../src/watcher');

// These are pure functions, so the whole file runs on any platform. That is the
// point: the .cmd branch of windowsSafeSpawn is unreachable off win32 and the
// Windows CI job never spawns a batch shim, so the escaping would otherwise
// ship untested.

// --- models of the two consumers -------------------------------------------
// Not a second copy of the escaper -- these are the *inverse*: what cmd.exe and
// the target's C runtime do to the line we hand them. If escape-then-decode
// gives the argument back, the escaping is right for the real consumer rather
// than merely self-consistent.

/**
 * One cmd.exe parse of a command line. A caret escapes the next character, but
 * only outside a quoted region -- inside "..." cmd hands the caret through
 * literally, which is exactly the trap the escaper has to avoid. `sawQuote`
 * reports whether cmd ever entered such a region.
 */
function cmdPass(line) {
  let out = '';
  let inQuotes = false;
  let sawQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '^' && !inQuotes && i + 1 < line.length) { out += line[++i]; continue; }
    if (c === '"') { inQuotes = !inQuotes; sawQuote = true; }
    out += c;
  }
  return { out, sawQuote };
}

/** The MSVC CRT argv rules: 2n backslashes + `"` is n backslashes and a quote
 * toggle, 2n+1 is n backslashes and a literal quote, anything else is literal. */
function crtParse(token) {
  let out = '';
  let i = 0;
  while (i < token.length) {
    if (token[i] === '\\') {
      let n = 0;
      while (token[i] === '\\') { n++; i++; }
      if (token[i] === '"') { out += '\\'.repeat(n >> 1); if (n % 2) out += '"'; i++; } else out += '\\'.repeat(n);
      continue;
    }
    if (token[i] === '"') { i++; continue; }
    out += token[i++];
  }
  return out;
}

/** Full trip: cmd parses the line, the batch file's own parse eats a second
 * layer of carets, then the program's CRT splits what is left. */
function roundTrip(arg) {
  const first = cmdPass(escapeArgForCmd(arg));
  const second = cmdPass(first.out);
  return { value: crtParse(second.out), sawQuote: first.sawQuote || second.sawQuote, batchLine: second.out };
}

const METACHARS = ['(', ')', '[', ']', '%', '!', '^', '"', '`', '<', '>', '&', '|', ';', ',', ' ', '*', '?'];

// Payloads phantom actually passes through. The JSON blob is the --settings
// value; before the win32 branch existed cmd.exe re-parsed it, ate the quotes
// and handed Claude Code `{permissions:{deny:[Read(.env)]}}`, which is not JSON.
const SETTINGS_JSON = '{"permissions":{"deny":["Read(.env)"]}}';
const ALLOWLIST_ENTRY = 'Bash(node --test test/math.test.js)';
const INLINE_SCRIPT = 'console.log("hi")';

test('a plain argument is CRT-quoted first, then the quotes are caret-escaped twice', () => {
  // "hello" -> ^"hello^" after one caret pass -> ^^^"hello^^^" after the second.
  assert.strictEqual(escapeArgForCmd('hello'), '^^^"hello^^^"');
  // An empty argument still has to reach the child as a present-but-empty argv
  // slot, so it must not collapse to nothing.
  assert.strictEqual(escapeArgForCmd(''), '^^^"^^^"');
  // A space is a cmd metacharacter as well as an argv separator, so it is both
  // inside the CRT quotes and caret-escaped.
  assert.strictEqual(escapeArgForCmd('a b'), '^^^"a^^^ b^^^"');
  // spawn() stringifies argv entries; the escaper has to do the same rather
  // than throw on a number a caller passed through.
  assert.strictEqual(escapeArgForCmd(42), '^^^"42^^^"');
});

test('quoting happens before the caret pass, so no metacharacter sits in a cmd-visible quoted region', () => {
  for (const arg of [...METACHARS, SETTINGS_JSON, ALLOWLIST_ENTRY, INLINE_SCRIPT, 'a b', '']) {
    const escaped = escapeArgForCmd(arg);
    // If the carets were applied first and the quotes added afterwards, the
    // result would start with a bare `"` and cmd would treat everything up to
    // the next quote as quoted -- carets inert, metacharacters live.
    assert.ok(escaped.startsWith('^^^"'), 'leading quote not escaped for ' + JSON.stringify(arg));
    assert.ok(escaped.endsWith('^^^"'), 'trailing quote not escaped for ' + JSON.stringify(arg));
    assert.ok(!/(?:^|[^^])"/.test(escaped), 'bare quote left in ' + JSON.stringify(arg));
    assert.strictEqual(roundTrip(arg).sawQuote, false, 'cmd enters a quoted region for ' + JSON.stringify(arg));
  }
});

test('every cmd metacharacter is escaped twice, because a batch file parses its line again', () => {
  for (const meta of METACHARS) {
    const escaped = escapeArgForCmd(meta);
    // `^^^` + char: one caret for cmd's parse of the /c line, and that caret
    // itself escaped for the batch file's second parse. A single `^` + char
    // would survive cmd but be eaten before the shim ever ran.
    const marker = meta === '"' ? '\\^^^"' : '^^^' + meta;
    assert.ok(escaped.includes(marker), 'not double-escaped: ' + JSON.stringify(meta) + ' -> ' + escaped);
    assert.strictEqual(roundTrip(meta).value, meta);
  }
});

test('embedded double quotes follow the CRT backslash-run rules', () => {
  // a"b: the quote is not preceded by backslashes, so it just gains one.
  assert.strictEqual(escapeArgForCmd('a"b'), '^^^"a\\^^^"b^^^"');
  // a\"b: one literal backslash before the quote. The run is doubled (so the
  // CRT reads it as one literal backslash) and only then is the quote escaped.
  assert.strictEqual(escapeArgForCmd('a\\"b'), '^^^"a\\\\\\^^^"b^^^"');
  // a\\"b: two literal backslashes -> four, plus the escaped quote.
  assert.strictEqual(escapeArgForCmd('a\\\\"b'), '^^^"a\\\\\\\\\\^^^"b^^^"');
  for (const arg of ['a"b', 'a\\"b', 'a\\\\"b', 'a\\\\\\"b', '"', 'ends"', 'q"\\', INLINE_SCRIPT]) {
    assert.strictEqual(roundTrip(arg).value, arg, 'round trip failed for ' + JSON.stringify(arg));
  }
});

test('a trailing backslash is doubled so it cannot escape the closing quote', () => {
  // C:\path\ is the shape every Windows cwd or --output-dir argument has. Left
  // alone it would arrive as `"C:\path\"`, whose final backslash escapes the
  // closing quote and swallows the rest of the command line into the argument.
  assert.strictEqual(escapeArgForCmd('C:\\path\\'), '^^^"C:\\path\\\\^^^"');
  assert.strictEqual(escapeArgForCmd('trail\\\\'), '^^^"trail\\\\\\\\^^^"');
  for (const arg of ['C:\\path\\', 'trail\\\\', 'C:\\a b\\x\\', 'C:\\Program Files\\node\\node.exe']) {
    assert.strictEqual(roundTrip(arg).value, arg, 'round trip failed for ' + JSON.stringify(arg));
    // Interior backslashes that are not part of a quote or trailing run stay
    // literal -- a path must not have its separators doubled everywhere.
    assert.ok(!escapeArgForCmd(arg).includes('C:\\\\'), 'interior separator doubled in ' + arg);
  }
});

test('phantom real payloads survive both cmd parses intact', () => {
  // The regression this whole branch exists for: node -e with a quoted string.
  assert.strictEqual(roundTrip(INLINE_SCRIPT).value, INLINE_SCRIPT);
  // --settings JSON: braces are inert but the quotes, brackets and parens are
  // not, and losing any of them turns the value into unparseable garbage.
  assert.strictEqual(roundTrip(SETTINGS_JSON).value, SETTINGS_JSON);
  // An --allowedTools entry: parens and spaces inside one argv slot.
  assert.strictEqual(roundTrip(ALLOWLIST_ENTRY).value, ALLOWLIST_ENTRY);
  // %VAR% and !VAR! must reach the child as literal text, not be expanded by
  // cmd or by delayed expansion inside the shim.
  assert.strictEqual(roundTrip('%PATH%').value, '%PATH%');
  assert.strictEqual(roundTrip('!DELAYED!').value, '!DELAYED!');
  // Redirection and chaining operators must not split the command line.
  assert.strictEqual(roundTrip('a&b|c>d<e').value, 'a&b|c>d<e');
});

// --- resolveWindowsCommand --------------------------------------------------
// A synthetic env is passed everywhere so nothing here depends on the host PATH
// or on the host being Windows. Extensions in the fixtures match the case of
// the PATHEXT entry used to find them, because the test filesystem may be
// case-sensitive where a real Windows one would not be.

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-winspawn-'));
  const withSpace = path.join(root, 'dir one');
  const plain = path.join(root, 'dirtwo');
  fs.mkdirSync(withSpace);
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(withSpace, 'tool.exe'), '');
  fs.writeFileSync(path.join(withSpace, 'tool.cmd'), '');
  fs.writeFileSync(path.join(plain, 'tool.cmd'), '');
  fs.writeFileSync(path.join(plain, 'other.cmd'), '');
  return { root, withSpace, plain };
}

test('PATHEXT is honoured in order, per directory', () => {
  const { root, withSpace, plain } = fixtureRoot();
  // Directory-major, extension-minor: the first PATH entry wins even though a
  // later one holds the extension listed first. That is cmd.exe's order.
  const env = { PATHEXT: '.exe;.cmd', Path: withSpace + ';' + plain };
  assert.strictEqual(resolveWindowsCommand('tool', root, env), path.join(withSpace, 'tool.exe'));
  // Same directory, reversed PATHEXT: now the shim wins, which is what decides
  // whether windowsSafeSpawn routes through cmd.exe at all.
  assert.strictEqual(
    resolveWindowsCommand('tool', root, { ...env, PATHEXT: '.cmd;.exe' }),
    path.join(withSpace, 'tool.cmd'),
  );
  // The decisive case for the loop nesting: the first directory holds only the
  // .cmd, the second holds the .exe that PATHEXT prefers. Directory order wins,
  // so this must be the shim -- an extension-major search would return the .exe
  // and phantom would skip the cmd.exe wrapper the shim needs.
  assert.strictEqual(
    resolveWindowsCommand('tool', root, { PATHEXT: '.exe;.cmd', Path: plain + ';' + withSpace }),
    path.join(plain, 'tool.cmd'),
  );
  // Only the second directory has `other`, so the search does keep walking.
  assert.strictEqual(resolveWindowsCommand('other', root, env), path.join(plain, 'other.cmd'));
});

test('PATH entries are unquoted and empty entries skipped', () => {
  const { root, withSpace, plain } = fixtureRoot();
  // Windows PATH entries containing spaces are routinely stored quoted, and a
  // stray trailing `;` leaves an empty entry that must not resolve to cwd.
  const env = { PATHEXT: '.cmd', Path: ';"' + withSpace + '";' + plain + ';' };
  assert.strictEqual(resolveWindowsCommand('tool', root, env), path.join(withSpace, 'tool.cmd'));
  // Path and PATH are the same variable on Windows; either spelling is read.
  assert.strictEqual(resolveWindowsCommand('other', root, { PATHEXT: '.cmd', PATH: plain }), path.join(plain, 'other.cmd'));
});

test('a command that already has an extension is used as-is', () => {
  const { root, withSpace } = fixtureRoot();
  const env = { PATHEXT: '.exe;.cmd', Path: withSpace };
  // Asking for tool.cmd must not be answered with tool.exe just because .exe
  // comes first in PATHEXT.
  assert.strictEqual(resolveWindowsCommand('tool.cmd', root, env), path.join(withSpace, 'tool.cmd'));
  // And no PATHEXT suffix is appended on top of an existing one.
  assert.strictEqual(resolveWindowsCommand('tool.exe', root, env), path.join(withSpace, 'tool.exe'));
  assert.strictEqual(resolveWindowsCommand('tool.bat', root, env), null);
});

test('a command containing a separator is a path, not a PATH lookup', () => {
  const { root, withSpace, plain } = fixtureRoot();
  // PATH points somewhere that also has a `tool`, to prove it is ignored.
  const env = { PATHEXT: '.cmd', Path: plain };
  assert.strictEqual(resolveWindowsCommand('./tool', withSpace, env), path.join(withSpace, 'tool.cmd'));
  // A backslash counts as a separator too, so `.\tool` is a path and is never
  // answered from PATH. (Off win32 path.resolve cannot join a backslash form,
  // so all that is observable here is that PATH was not consulted -- on Windows
  // this same call resolves to the cwd copy.)
  assert.strictEqual(resolveWindowsCommand('.\\tool', withSpace, env), null);
  // An absolute path resolves against itself regardless of cwd.
  assert.strictEqual(resolveWindowsCommand(path.join(withSpace, 'tool'), root, env), path.join(withSpace, 'tool.cmd'));
  // Relative to cwd, reaching into a sibling directory.
  assert.strictEqual(resolveWindowsCommand('../dirtwo/other', withSpace, env), path.join(plain, 'other.cmd'));
});

test('unresolvable commands return null instead of guessing', () => {
  const { root, withSpace, plain } = fixtureRoot();
  const env = { PATHEXT: '.exe;.cmd', Path: withSpace + ';' + plain };
  assert.strictEqual(resolveWindowsCommand('nosuchthing', root, env), null);
  // A directory named like an executable is not an executable.
  fs.mkdirSync(path.join(plain, 'adir.exe'));
  assert.strictEqual(resolveWindowsCommand('adir', root, env), null);
  // No PATH at all, and an unreadable entry, both degrade to null rather than
  // throwing out of the spawn path.
  assert.strictEqual(resolveWindowsCommand('tool', root, { PATHEXT: '.cmd' }), null);
  assert.strictEqual(resolveWindowsCommand('tool', root, { PATHEXT: '.cmd', Path: path.join(root, 'gone') }), null);
  // A bare name is looked up on PATH only -- cwd is deliberately not searched,
  // so a stray tool.cmd in the working directory cannot hijack the command.
  assert.strictEqual(resolveWindowsCommand('tool', withSpace, { PATHEXT: '.cmd', Path: plain }), path.join(plain, 'tool.cmd'));
});

test('the default PATHEXT applies when the environment does not set one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-winspawn-'));
  // Uppercase on disk to match the built-in default exactly, so the fixture
  // works on a case-sensitive filesystem too.
  fs.writeFileSync(path.join(root, 'shim.CMD'), '');
  assert.strictEqual(resolveWindowsCommand('shim', root, { Path: root }), path.join(root, 'shim.CMD'));
});

// --- windowsSafeSpawn -------------------------------------------------------

test('windowsSafeSpawn is the identity off win32', () => {
  // Off win32 this is the only reachable branch: the cmd.exe branch is gated on
  // process.platform and cannot be exercised here, so what it produces is
  // covered indirectly by the escapeArgForCmd tests above.
  const { root, withSpace } = fixtureRoot();
  const env = { PATHEXT: '.cmd', Path: withSpace };
  const args = ['-e', INLINE_SCRIPT, '--settings', SETTINGS_JSON];
  const plain = windowsSafeSpawn('node', args, root, env);
  assert.strictEqual(plain.file, 'node');
  assert.deepStrictEqual(plain.argv, args);
  assert.deepStrictEqual(plain.opts, {});
  // Even a command that would resolve to a .cmd shim on Windows is passed
  // straight through here, untouched -- no escaping, no cmd.exe.
  const shim = windowsSafeSpawn('tool', args, withSpace, env);
  assert.strictEqual(shim.file, 'tool');
  assert.deepStrictEqual(shim.argv, args);
  assert.deepStrictEqual(shim.opts, {});
  assert.ok(!('windowsVerbatimArguments' in shim.opts));
});
