'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'src', 'guard-hook.js');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-guard-'));
const reportPath = path.join(cwd, '.phantom', 'reports', 'r.md');
const baseGuard = { neverTouch: ['.env', '.env.*', '**/*.pem', '**/secrets/**', '.git/**', 'node_modules/**'], cwd, dryRun: false, testCommand: 'npm test', reportPath };

function run(event, guard = baseGuard, { rawStdin, noGuard, hook = HOOK } = {}) {
  const env = { ...process.env };
  delete env.PHANTOM_GUARD;
  if (!noGuard) env.PHANTOM_GUARD = JSON.stringify(guard);
  const r = spawnSync(process.execPath, [hook], { input: rawStdin !== undefined ? rawStdin : JSON.stringify(event), env, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr.trim(), stdout: r.stdout };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd, hook_event_name: 'PreToolUse' });
const file = (tool, file_path) => ({ tool_name: tool, tool_input: { file_path }, cwd, hook_event_name: 'PreToolUse' });

test('fails closed on malformed input', () => {
  assert.equal(run(null, baseGuard, { rawStdin: 'not json' }).code, 2);
  assert.match(run(null, baseGuard, { rawStdin: '' }).stderr, /could not parse hook input/);
  assert.match(run(bash('ls'), baseGuard, { noGuard: true }).stderr, /PHANTOM_GUARD/);
});

test('the guard config can arrive in a file, which is the only form Windows can use', () => {
  // cmd.exe has no `VAR=value cmd` prefix, so the POSIX command line could not
  // carry PHANTOM_GUARD and the hook was skipped on Windows entirely. The deny
  // rules left behind cover the file tools but not Bash, while the allowlist
  // grants Bash(cat *) -- so `cat .env` was unguarded there and nowhere else.
  const guardFile = path.join(cwd, 'guard-config.json');
  fs.writeFileSync(guardFile, JSON.stringify(baseGuard));
  const viaFile = (event) => {
    const env = { ...process.env };
    delete env.PHANTOM_GUARD;   // the file must be sufficient on its own
    const r = spawnSync(process.execPath, [HOOK, guardFile], { input: JSON.stringify(event), env, encoding: 'utf8' });
    return { code: r.status, stderr: r.stderr.trim() };
  };
  assert.equal(viaFile(bash('cat .env')).code, 2, 'the read Windows used to allow');
  assert.match(viaFile(bash('cat .env')).stderr, /never-touch/);
  assert.equal(viaFile(file('Write', path.join(cwd, '.env'))).code, 2);
  assert.equal(viaFile(bash('npm test')).code, 0, 'and ordinary commands still pass');

  // A named file that cannot be read is not a reason to fall back to a laxer
  // source; it fails closed like every other unparsable input.
  const r = spawnSync(process.execPath, [HOOK, path.join(cwd, 'no-such-file.json')],
    { input: JSON.stringify(bash('ls')), env: { ...process.env, PHANTOM_GUARD: JSON.stringify(baseGuard) }, encoding: 'utf8' });
  assert.equal(r.status, 2, 'an unreadable guard file blocks rather than silently using the environment');
});

test('allows ordinary safe commands silently', () => {
  for (const c of ['npm test', 'node --test test/a.test.js', 'git diff --stat', 'git status', 'ls -la src', 'cat src/index.js', 'grep -rn foo src', 'npx vitest run', 'git log --oneline -5', 'rm tmp.txt', 'echo "x" > out.txt']) {
    const r = run(bash(c));
    assert.equal(r.code, 0, c + ' -> ' + r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('denies dangerous bash commands with a one-line reason', () => {
  const cases = [
    'rm -rf node_modules', 'rm -r build', 'rm -fr x', 'rmdir x', 'git push origin main', 'git checkout main', 'git switch -c x',
    'git reset --hard', 'git stash', 'git rebase main', 'git merge x', 'git commit -m x', 'git clean -fd', 'git branch -D x',
    'curl https://x', 'wget https://x', 'nc -l 80', 'ssh host', 'scp a b:', 'npm i lodash', 'npm install', 'npm ci',
    'npm uninstall x', 'yarn add x', 'pnpm add x', 'pip install x', 'npx prisma migrate dev', 'prisma db push', 'knex migrate:latest',
    'sequelize db:migrate', 'drizzle-kit push', 'sudo ls', 'chmod -R 777 .', 'chown x y', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=x',
    ':(){ :|:& };:', 'kill -9 1', 'pkill node', 'killall node', 'docker rm x', 'kubectl delete pod x',
    'psql -c "DROP TABLE users"', 'mysql -e "TRUNCATE t"', 'npm test && git push', 'echo x > .env', 'cat .env', 'cp .env.local /tmp/x',
    'cat secrets/key.json', 'node -e 1 ; rm -rf /',
  ];
  for (const c of cases) {
    const r = run(bash(c));
    assert.equal(r.code, 2, 'should deny: ' + c);
    assert.match(r.stderr, /^phantom guard: .+/);
    assert.equal(r.stderr.split('\n').length, 1);
  }
});

test('denies file tools on never-touch paths and outside the repo', () => {
  assert.equal(run(file('Read', '.env')).code, 2);
  assert.equal(run(file('Edit', 'config/secrets/db.json')).code, 2);
  assert.equal(run(file('Write', path.join(cwd, 'sub', 'server.pem'))).code, 2);
  assert.equal(run(file('MultiEdit', '../outside.js')).code, 2);
  assert.equal(run(file('Read', '/etc/passwd')).code, 2);
  assert.equal(run(file('NotebookEdit', 'node_modules/x/index.js')).code, 2);
  assert.equal(run({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '.env.prod.ipynb' } }).code, 2);
  assert.equal(run({ tool_name: 'Grep', tool_input: { pattern: 'x', path: 'secrets' } }).code, 2);
});

test('allows file tools inside the repo on normal paths', () => {
  assert.equal(run(file('Edit', 'src/index.js')).code, 0);
  assert.equal(run(file('Write', path.join(cwd, 'test', 'new.test.js'))).code, 0);
  assert.equal(run(file('Read', 'package.json')).code, 0);
  assert.equal(run({ tool_name: 'Grep', tool_input: { pattern: 'x' } }).code, 0);
  assert.equal(run({ tool_name: 'Glob', tool_input: { pattern: '**/*.js' } }).code, 0);
  assert.equal(run({ tool_name: 'TodoWrite', tool_input: {} }).code, 0);
});

test('dry run blocks every write except the report', () => {
  const guard = { ...baseGuard, dryRun: true };
  assert.equal(run(file('Edit', 'src/index.js'), guard).code, 2);
  assert.equal(run(file('Write', 'src/new.js'), guard).code, 2);
  assert.equal(run(file('MultiEdit', 'src/index.js'), guard).code, 2);
  assert.equal(run(file('Write', reportPath), guard).code, 0);
  assert.equal(run(file('Write', path.relative(cwd, reportPath)), guard).code, 0);
  assert.equal(run(file('Read', 'src/index.js'), guard).code, 0);
  assert.equal(run(bash('npm test'), guard).code, 0);
});

test('works without the never-touch module (fallback matcher)', () => {
  const { fallbackIsNeverTouch } = require('../src/guard-hook');
  assert.ok(fallbackIsNeverTouch('a/b/.env', ['.env']));
  assert.ok(fallbackIsNeverTouch('x/secrets/y.json', ['**/secrets/**']));
  assert.ok(fallbackIsNeverTouch('k.pem', ['**/*.pem']));
  assert.ok(!fallbackIsNeverTouch('src/env.js', ['.env', '**/*.pem']));
});

test('denies lightly obfuscated dangerous commands (quotes, backticks, bash -c, key=value, option order)', () => {
  const cases = [
    'bash -c "rm -rf x"', "sh -c 'rm -rf x'", 'eval "rm -rf x"', 'echo `rm -rf x`', "git 'push'", 'r\\m -rf x',
    'git -C /tmp push', 'git -C . -c a=b push origin', 'git --no-pager -c x=y reset --hard', 'git update-ref -d refs/heads/main',
    'git symbolic-ref HEAD refs/heads/x', 'git tag -d v1', 'git filter-branch --all', 'git gc --prune=now', 'git reflog expire --all',
    'git config user.name x', 'git config --global x y', 'git rm -r src', 'git mv a b',
    'rm --recursive x', 'find . -name "*.js" -delete', 'find src -exec rm {} \;', 'xargs rm -r < list',
    'chmod 777 -R .', 'kill -s KILL 1', 'dd of=.env', 'npm exec prisma migrate', 'npx --yes prisma migrate dev', 'yarn dlx prisma migrate',
    'wget2 http://x', 'rsync -a . host:', 'env', 'printenv', 'export', 'set', 'npm test; env', 'env > dump.txt',
  ];
  for (const c of cases) {
    const r = run(bash(c));
    assert.equal(r.code, 2, 'should deny: ' + c);
    assert.match(r.stderr, /^phantom guard: .+/);
  }
});

test('still allows read-only git, option-bearing commands and env-prefixed commands', () => {
  for (const c of ['git --no-pager merge-base main HEAD', 'git config user.name', 'git config --get core.editor', 'git log -n 5 -- src', 'git tag', 'git tag -l',
    'set -e; npm test', 'export NODE_ENV=test && npm test', 'env NODE_ENV=test npm test', 'node -e "console.log(process.env.HOME)"', 'npm run build', 'rm -- -r', 'rm tmp.txt']) {
    const r = run(bash(c));
    assert.equal(r.code, 0, c + ' -> ' + r.stderr);
  }
});

test('never-touch paths: quote splitting, globs, case, symlinks, and paths outside the repo', () => {
  fs.writeFileSync(path.join(cwd, '.env'), 'X=1\n');
  fs.writeFileSync(path.join(cwd, '.env.local'), 'X=1\n');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  try { fs.symlinkSync(path.join('..', '.env'), path.join(cwd, 'sub', 'link')); } catch { /* exists */ }
  fs.writeFileSync(path.join(cwd, '..', 'phantom-guard-outside.env'), 'X=1\n');
  for (const c of ['cat "."env', 'cat .\\env', 'cat .e""nv', 'cat .env*', 'cat .en?', 'cat .ENV', 'cat sub/link', 'cat ../../.env', 'cat ' + path.join(cwd, '..', '.env'),
    'cat --file=.env', 'cp .env.local /tmp/x', 'cat sub/../.env']) {
    const r = run(bash(c));
    assert.equal(r.code, 2, 'should deny: ' + c);
  }
  assert.equal(run(file('Read', 'sub/link')).code, 2, 'symlink into a never-touch file');
  assert.equal(run(file('Read', '.ENV')).code, 2, 'case-insensitive');
  assert.equal(run(file('Edit', '.Env.Local')).code, 2);
  for (const c of ['cat .envrc', 'cat src/*.js', 'ls sub', 'cat README.md', 'node src/env.js']) {
    const r = run(bash(c));
    assert.equal(r.code, 0, c + ' -> ' + r.stderr);
  }
  assert.equal(run(file('Read', 'sub/other')).code, 0);
});

test('a Windows absolute path keeps its separators so the guard cannot fail open', () => {
  const { tokenizeCommand } = require('../src/guard-hook');

  // Backslash stripping exists to undo shell escaping, and on POSIX that is all
  // a backslash means: `.\env` is `.env`, `r\m` is `rm`.
  assert.deepEqual(tokenizeCommand('cat .\\env', 'linux'), ['cat', '.env']);
  assert.deepEqual(tokenizeCommand('r\\m -rf x', 'linux'), ['rm', '-rf', 'x']);

  // On Windows the same strip destroys the path: C:\Users\me\.env became
  // C:Usersme.env, which matches no never-touch glob and no longer looks like
  // it escapes the repo -- so the guard allowed the write. Both spellings are
  // now emitted, and the intact one is what the never-touch check needs.
  const win = tokenizeCommand('cat C:\\Users\\me\\.env', 'win32');
  assert.ok(win.includes('C:\\Users\\me\\.env'), 'the intact path survives: ' + JSON.stringify(win));
  assert.ok(win.includes('C:Usersme.env'), 'the unescaped reading is still checked too');

  // The escaping case still works on Windows: both readings are offered, so a
  // shell-escaped `.\env` is caught by one and a real path by the other.
  assert.ok(tokenizeCommand('cat .\\env', 'win32').includes('.env'));

  // A token that reads the same either way is not duplicated.
  assert.deepEqual(tokenizeCommand('cat .env', 'win32'), ['cat', '.env']);
});

// guard-hook.js carries its own copy of the glob logic so the hook still blocks
// when src/never-touch.js is missing or broken. Two implementations of a
// security rule drift; when the fallback drifts it under-blocks and a `.env`
// write is quietly approved -- exactly the shape of the win32 backslash bug
// above. These fixtures pin the two against each other, over the globs phantom
// actually ships -- read from config.js so a new default that only one of the
// two understands fails here instead of in someone's repo.
const { DEFAULTS, ALWAYS_NEVER_TOUCH } = require('../src/config');
const REAL_DEFAULTS = [...DEFAULTS.neverTouch, ...ALWAYS_NEVER_TOUCH];

const PARITY_GLOBS = [
  REAL_DEFAULTS,
  ['.env'], ['.env.*'], ['**/*.pem'], ['**/*.key'], ['**/secrets/**'], ['**/*.secret*'], ['.git/**'], ['node_modules/**'],
  ['secrets/**'], ['./.env'], ['config/*.env'], ['a/**/b.key'], ['?.env'], ['*'], ['**'], ['**/*'],
];

const PARITY_PATHS = [
  // the never-touch files themselves, at the root and nested
  '.env', '.env.local', '.env.production', 'sub/.env', 'a/b/c/.env', './.env', '.ENV', '.Env.Local',
  'key.pem', 'a/b/key.pem', 'id_rsa.key', 'a/id_rsa.key', '.key', 'app.secret', 'a/b.secrets.json',
  'secrets', 'secrets/db.json', 'a/secrets', 'a/secrets/b/c.json', 'config/dev.env', 'a/x/b.key',
  '.git', '.git/config', 'a/.git/config', 'node_modules', 'node_modules/x/index.js',
  // near-misses: the real defaults must not claim these, and neither must the fallback
  '.environment', 'env.js', 'src/env.js', 'my.env.example', '.envrc', 'env', 'aenv', 'myenv', 'a/env',
  '.gitignore', 'gitconfig', 'pem', 'x.pem.bak', 'keyfile', 'secretsauce/x', 'x/secrets.json', 'secret',
  'README.md', 'package.json', 'src/index.js',
  // a `*` must not cross a directory boundary in either implementation
  '.env.d/x.js', 'key.pem/x', 'a.secret/b',
  // win32 spelling: both implementations normalise separators before matching
  'sub\\.env', 'a\\b\\.env', 'C:\\Users\\me\\.env', 'sub\\secrets\\a.json', '.\\env',
  // absolute and escaping spellings, as hitsNeverTouch hands them over
  'etc/passwd', 'Users/me/.env', 'C:/Users/me/.env', '../.env', 'a/../.env', '..', '.',
];

test('the fallback matcher and never-touch.js return the same verdict (a divergence is a silent hole in the guard)', () => {
  const { isNeverTouch } = require('../src/never-touch');
  const { fallbackIsNeverTouch } = require('../src/guard-hook');

  // Guard against a corpus that has quietly degenerated into all-false, which
  // would make every parity assertion below true for the wrong reason.
  const matched = PARITY_PATHS.filter((p) => isNeverTouch(p, REAL_DEFAULTS));
  assert.ok(matched.length >= 20, 'corpus should exercise real matches, got ' + matched.length);
  assert.ok(PARITY_PATHS.some((p) => !isNeverTouch(p, REAL_DEFAULTS)), 'corpus should exercise real non-matches');

  for (const globs of PARITY_GLOBS) {
    for (const p of PARITY_PATHS) {
      const real = isNeverTouch(p, globs);
      assert.equal(fallbackIsNeverTouch(p, globs), real,
        'fallback disagrees on ' + JSON.stringify(p) + ' against ' + JSON.stringify(globs) + ' (never-touch.js says ' + real + ')');
    }
  }
});

// KNOWN BUG, not a wishlist: never-touch.js honours these and the fallback does
// not, so with a broken never-touch.js the guard silently stops enforcing them.
// `{a,b}` and whitespace-padded globs both reach here straight from a user's
// .phantomrc -- config.js validates neverTouch entries as strings and neither
// trims nor rejects them. Marked todo so the suite stays green until
// fallbackGlobToRegExp/fallbackIsNeverTouch grow brace alternation, a glob
// trim, and normalizePath's leading-slash strip; it flips to passing then.
test('the fallback matcher honours brace alternation, padded globs and leading slashes', () => {
  const { fallbackIsNeverTouch } = require('../src/guard-hook');
  assert.ok(fallbackIsNeverTouch('key.pem', ['*.{pem,key}']), 'brace alternation');
  assert.ok(fallbackIsNeverTouch('a/b/id_rsa.key', ['*.{pem,key}']), 'brace alternation, nested');
  assert.ok(fallbackIsNeverTouch('.env', [' .env ']), 'glob is trimmed before matching');
  assert.ok(fallbackIsNeverTouch('/.git/config', ['.git/**']), 'leading slash is stripped from the path');
  assert.ok(!fallbackIsNeverTouch('sub/', ['']), 'an empty glob matches nothing');
});

/** A copy of the hook whose sibling never-touch.js is `body`, so the fallback path is what actually runs. */
function hookWith(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-guard-broken-'));
  fs.copyFileSync(HOOK, path.join(dir, 'guard-hook.js'));
  fs.writeFileSync(path.join(dir, 'never-touch.js'), body);
  return path.join(dir, 'guard-hook.js');
}

test('a broken never-touch.js does not open the guard: the fallback matcher still blocks', () => {
  const hook = hookWith("throw new Error('never-touch.js is broken');\n");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-guard-repo-'));
  fs.writeFileSync(path.join(repo, '.env'), 'X=1\n');
  fs.mkdirSync(path.join(repo, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'secrets', 'db.json'), '{}\n');
  const guard = { ...baseGuard, cwd: repo, reportPath: path.join(repo, '.phantom', 'reports', 'r.md') };
  const ev = (e) => ({ ...e, cwd: repo });

  // The whole point of the fallback: the module is gone, the writes are still denied.
  const write = run(ev(file('Write', '.env')), guard, { hook });
  assert.equal(write.code, 2, 'writing .env must still be denied: ' + JSON.stringify(write));
  assert.match(write.stderr, /never-touch path: \.env/);
  assert.equal(run(ev(file('Edit', 'secrets/db.json')), guard, { hook }).code, 2);
  // Bash tokens reach the matcher by a different route than file tools do, and
  // these two commands have no other rule that would catch them.
  assert.equal(run(ev(bash('cat .env')), guard, { hook }).code, 2);
  assert.equal(run(ev(bash('cat secrets/db.json')), guard, { hook }).code, 2);

  // expandGlob picks its own regex builder from whichever matcher loadMatcher
  // returned; if that wiring breaks, `.env*` is never expanded and the write is
  // approved, which is why the glob spelling is checked here and not only above.
  assert.equal(run(ev(bash('cat .env*')), guard, { hook }).code, 2, 'shell glob must still expand to .env');

  // Failing closed must not mean failing shut: ordinary work still runs.
  assert.equal(run(ev(bash('npm test')), guard, { hook }).code, 0);
  assert.equal(run(ev(file('Edit', 'src/index.js')), guard, { hook }).code, 0);
});

test('a dry run refuses Bash commands that write, not just the file tools', () => {
  // checkFile refused every WRITE_TOOL under --dry-run from the start, but
  // checkBash had no dry-run branch at all, so the mode that promises "nothing
  // is touched" allowed `echo patched > src/app.js`, `sed -i` and `tee`. It is
  // the worst place for that gap: dry run creates no branch, so those writes
  // land on the user's own checkout with nothing to roll them back.
  const dry = { ...baseGuard, dryRun: true };
  const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } }, dry);

  // Refused *by the dry-run rule* -- none of these trip any other check, so the
  // reason names the mode. `rm -rf build` is deliberately not in this list: it
  // is already refused as a recursive rm, and asserting the dry-run wording on
  // it would only pin which rule happens to match first.
  const blockedByDryRun = [
    'echo patched > src/app.js',
    'printf x >> notes.txt',
    'cat patch | tee src/app.js',
    'sed -i "s/a/b/" src/app.js',
    'mv a.js b.js',
    'cp a.js b.js',
    'touch newfile.js',
    'mkdir scratch',
    'chmod +x run.sh',
  ];
  for (const command of blockedByDryRun) {
    const r = bash(command);
    assert.equal(r.code, 2, 'should be refused in a dry run: ' + command);
    assert.match(r.stderr, /dry run: no writes/, command);
  }
  // Already refused in both modes by rules that predate this one; all that
  // matters here is that dry run does not somehow let them through.
  for (const command of ['rm -rf build', 'git apply fix.diff', 'git checkout -- src/app.js', 'npm install lodash']) {
    assert.equal(bash(command).code, 2, command);
  }

  // Reading and verifying are the whole point of a dry run, so they must work.
  const allowed = [
    'npm test',
    'node --test test/math.test.js',
    'cat src/app.js',
    'grep -rn TODO src',
    'ls -la src',
    'git status',
    'git diff',
    'node app.js 2>&1',      // descriptor duplication, not a file write
    'echo problem >&2',
  ];
  for (const command of allowed) {
    assert.equal(bash(command).code, 0, 'should be allowed in a dry run: ' + command);
  }

  // And none of this changes outside dry run, where patching is the job.
  for (const command of ['sed -i "s/a/b/" src/app.js', 'echo x > src/app.js', 'mkdir scratch', 'mv a.js b.js', 'touch newfile.js']) {
    assert.equal(run({ tool_name: 'Bash', tool_input: { command } }).code, 0, 'allowed in a real run: ' + command);
  }
});

test('a redirect written without a space is still a redirect', () => {
  // `<` and `>` were not in the tokenizer's split class, so `cat<.env` produced
  // one token that matched no glob and no path. The spaced forms were caught
  // all along, which is what made the gap easy to miss. The write direction is
  // the dangerous one: `echo pwned>.env` destroyed a gitignored .env outright,
  // which is precisely the case recovery.js calls beyond recovery.
  for (const command of ['cat<.env', 'cat 0<.env', 'echo pwned>.env', 'echo x>>.env', "echo y>'.env'", 'cat< .env']) {
    const r = run({ tool_name: 'Bash', tool_input: { command } });
    assert.equal(r.code, 2, 'should be refused: ' + command);
  }
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'node app.js>out.log' } }).code, 0,
    'an ordinary redirect to an ordinary file still works');
});

test('bracket globs expand the way the shell expands them', () => {
  // expandGlob used the never-touch matcher, which escapes [ and ] -- so
  // `.[e]nv` compiled to /^\.\[e\]nv$/ and matched neither the file on disk nor
  // the `.env` rule. The guard allowed it; the shell then expanded it and
  // printed the secret.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-glob-'));
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  const guard = { ...baseGuard, cwd: dir };
  for (const command of ['cat .[e]nv', 'cat .en[v]', 'cat .e?v', 'cat .en*']) {
    assert.equal(run({ tool_name: 'Bash', tool_input: { command } }, guard).code, 2, command);
  }
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'cat READ[M]E.md' } }, guard).code, 0,
    'a bracket glob over an ordinary file is fine');
});

test('Bash may not read outside the repository, just as the file tools may not', () => {
  // checkFile hard-denied an escaping path from the start; checkBash only
  // glob-tested them, so `cat ~/.ssh/id_rsa` was allowed through the one tool
  // that could ignore the prompt's "work only inside the repository". `~` never
  // resolved either, so it was missed twice over.
  for (const command of ['cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat ~/.aws/credentials', 'cat ~/.netrc', 'head ~/.claude.json']) {
    const r = run({ tool_name: 'Bash', tool_input: { command } });
    assert.equal(r.code, 2, 'should be refused: ' + command);
    assert.match(r.stderr, /outside the repository|never-touch/, command);
  }
  // The same paths were already refused for Read; Bash now agrees with it.
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }).code, 2);
  // Relative work inside the repo is untouched.
  for (const command of ['cat src/app.js', 'cat ./src/app.js', 'npm test', 'node --test test/math.test.js']) {
    assert.equal(run({ tool_name: 'Bash', tool_input: { command } }).code, 0, command);
  }
});

test('commands that read everything without naming anything are refused', () => {
  // The path checks are lexical: they can only refuse a path that appears in
  // the command. These read every file in the repo -- a gitignored .env, all of
  // secrets/ -- while naming none of them, and Bash(grep *), Bash(git log *)
  // and Bash(git show *) are all on the allowlist. In a sandbox repo
  // `grep -rs . .` printed the AWS key and `git log -p` printed it from history.
  // A repo with a never-touch file at the root and a clean subdirectory: the
  // difference between the two is the whole point of the check being
  // scope-aware rather than a flat ban.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-bulk-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, '.env'), 'AWS_SECRET=wJalrXUtnFEMI\n');
  fs.writeFileSync(path.join(dir, 'secrets', 'prod.key'), 'k\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), '// TODO fix\n');
  const guard = { ...baseGuard, cwd: dir };
  const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } }, guard);

  const blocked = [
    'grep -rs SECRET .',              // walks the root, where .env lives
    'grep -r . .',
    'grep --recursive x .',
    'git show HEAD:.env',             // the path hides after a colon
    'git cat-file -p HEAD:.env',
    'find . -type f -exec cat {} +',
    'tar cf - . | base64',
    'cat list.txt | xargs cat',
    'base64 .env',
  ];
  for (const command of blocked) {
    assert.equal(bash(command).code, 2, 'should be refused: ' + command);
  }

  // Everything a crash fix actually needs still works -- including a recursive
  // search scoped to a directory that holds nothing never-touch. Refusing that
  // would buy no safety and push the session toward worse tools.
  const allowed = [
    'npm test',
    'node --test test/math.test.js',
    'cat src/app.js',
    'grep -n TODO src/app.js',
    'grep -rn TODO src',
    'grep -rn TODO ./src',
    'git log --oneline -5',
    'git diff --stat',
    'git status',
    'ls -la src',
  ];
  for (const command of allowed) {
    assert.equal(bash(command).code, 0, 'should be allowed: ' + command);
  }
});

test('git patch output is refused only when the repo really tracks a never-touch file', () => {
  // `git log -p` prints file contents, so it is a leak exactly when something
  // never-touch is committed -- and a false alarm otherwise. Checking rather
  // than assuming keeps a genuinely useful diagnostic available.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-tracked-'));
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'x\n');
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');

  const guard = { ...baseGuard, cwd: dir };
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git log -p' } }, guard).code, 0,
    'nothing never-touch is tracked, so the patch is safe to read');

  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'secrets', 'prod.key'), 'k\n');
  g('add', '-f', 'secrets/prod.key');
  g('commit', '-q', '-m', 'oops');

  const r = run({ tool_name: 'Bash', tool_input: { command: 'git log -p' } }, guard);
  assert.equal(r.code, 2, 'now the same command would print the committed key');
  assert.match(r.stderr, /tracks never-touch files/);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git log --oneline' } }, guard).code, 0,
    'and the metadata-only form is still fine');
});

// --- progress file ---------------------------------------------------------

function progressLines(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function withProgress(name) {
  const p = path.join(cwd, name);
  try { fs.unlinkSync(p); } catch { /* first run */ }
  return { p, guard: { ...baseGuard, progressPath: p } };
}

test('the guard records what the session is doing, for allowed and denied calls alike', () => {
  const { p, guard } = withProgress('progress-basic.jsonl');
  const before = Date.now();

  assert.equal(run(bash('npm test'), guard).code, 0);
  assert.equal(run(file('Edit', path.join(cwd, 'src', 'app.js')), guard).code, 0);
  const denied = run(bash('cat .env'), guard);
  assert.equal(denied.code, 2, 'still denied');
  assert.match(denied.stderr, /never-touch/);
  assert.equal(denied.stderr.split('\n').length, 1, 'the progress write must not add to stderr');

  const lines = progressLines(p);
  assert.equal(lines.length, 3, 'one line per tool call, including the refusal');
  for (const l of lines) {
    assert.deepEqual(Object.keys(l).sort(), ['t', 'tool', 'what'], 'exactly the three agreed keys');
    assert.ok(Number.isInteger(l.t) && l.t >= before && l.t <= Date.now() + 1000, 'epoch ms: ' + l.t);
  }
  assert.deepEqual(lines.map((l) => l.tool), ['Bash', 'Edit', 'Bash']);
  assert.equal(lines[0].what, 'npm test');
  assert.equal(lines[1].what, 'src/app.js', 'file tools record the repo-relative path, not the absolute one');
  assert.equal(lines[2].what, 'cat .env', 'the denied call is the one a watching user most wants to see');
});

test('a search records its path, or its pattern when it has no path', () => {
  const { p, guard } = withProgress('progress-search.jsonl');
  const ev = (tool, tool_input) => ({ tool_name: tool, tool_input, cwd, hook_event_name: 'PreToolUse' });
  assert.equal(run(ev('Grep', { pattern: 'TODO', path: path.join(cwd, 'src') }), guard).code, 0);
  assert.equal(run(ev('Grep', { pattern: 'ENOENT rename' }), guard).code, 0);
  assert.equal(run(ev('Glob', { pattern: 'test/**/*.test.js' }), guard).code, 0);

  const lines = progressLines(p);
  assert.deepEqual(lines.map((l) => l.tool), ['Grep', 'Grep', 'Glob']);
  assert.equal(lines[0].what, 'src', 'a path beats the pattern');
  assert.equal(lines[1].what, 'ENOENT rename', 'a pathless search still says what it is looking for');
  assert.equal(lines[2].what, 'test/**/*.test.js');
});

test('a command on its way to the progress file is redacted before it is clipped', () => {
  const { p, guard } = withProgress('progress-secret.jsonl');
  const secret = 'AKIA1234567890ABCDEF';
  // Straddling the clip boundary is the case that matters: clip first and the
  // key loses its tail, which is exactly what every redact pattern keys on --
  // so the readable front of it survives into the file.
  const straddling = 'node scripts/deploy.js --region us-east-1 --key ' + secret;
  assert.ok(straddling.indexOf(secret) < 60 && straddling.length > 60, 'the fixture must span the clip');
  const commands = [straddling, 'echo ' + secret, 'aws configure set aws_secret_access_key ' + secret];
  for (const c of commands) assert.equal(run(bash(c), guard).code, 0, c);

  const whats = progressLines(p).map((l) => l.what);
  assert.equal(whats.length, commands.length);
  for (const what of whats) {
    assert.ok(!what.includes(secret), 'whole secret leaked: ' + what);
    assert.ok(!what.includes('AKIA'), 'a fragment of the secret leaked: ' + what);
    assert.ok(what.length <= 60, 'clipped to one terminal line: ' + what.length);
  }
  assert.match(whats[0], /\[REDACTED\]/);
});

test('a command it cannot redact is not written at all', () => {
  // hookWith gives the hook a directory with no redact.js beside it. Dropping
  // the command is the only safe answer: this file exists to be tailed on a
  // terminal, so an unredactable command must not reach it verbatim.
  const hook = hookWith('module.exports = { isNeverTouch: () => false };\n');
  const { p, guard } = withProgress('progress-no-redact.jsonl');
  const r = run(bash('deploy --token AKIA1234567890ABCDEF'), guard, { hook });
  assert.equal(r.code, 0, 'the verdict is unaffected');
  const lines = progressLines(p);
  assert.deepEqual(lines.map((l) => l.tool), ['Bash'], 'the call is still recorded');
  assert.equal(lines[0].what, '(command)');
});

test('a long command is clipped, and the clip is visible', () => {
  const { p, guard } = withProgress('progress-clip.jsonl');
  const long = 'node --test ' + 'test/very-long-file-name-'.repeat(8) + 'z.test.js';
  assert.equal(run(bash(long), guard).code, 0);
  const [line] = progressLines(p);
  assert.equal(line.what.length, 60);
  assert.ok(line.what.endsWith('…'), 'the truncation is marked: ' + line.what);
  assert.ok(long.startsWith(line.what.slice(0, -1)), 'and it is a prefix of the real command');
});

test('without progressPath the guard writes nothing at all', () => {
  const stray = path.join(cwd, 'progress-none.jsonl');
  try { fs.unlinkSync(stray); } catch { /* first run */ }
  const before = fs.readdirSync(cwd).sort();

  assert.equal(run(bash('npm test'), baseGuard).code, 0, 'verdicts are unchanged');
  assert.equal(run(bash('cat .env'), baseGuard).code, 2);
  assert.equal(run(bash('npm test'), { ...baseGuard, progressPath: '' }).code, 0);
  assert.equal(run(bash('npm test'), { ...baseGuard, progressPath: 42 }).code, 0, 'a non-string is not a path');

  assert.deepEqual(fs.readdirSync(cwd).sort(), before, 'no file appeared anywhere in the repo');
});

test('an unwritable progress path never becomes a denied tool call', () => {
  // The hook runs on every single tool call; a broken progress file must cost
  // the session nothing. Both shapes throw from appendFileSync.
  const missingDir = path.join(cwd, 'no-such-dir', 'progress.jsonl');
  const isADirectory = path.join(cwd, 'progress-dir');
  fs.mkdirSync(isADirectory, { recursive: true });

  for (const progressPath of [missingDir, isADirectory]) {
    const guard = { ...baseGuard, progressPath };
    const ok = run(bash('npm test'), guard);
    assert.equal(ok.code, 0, 'a safe command is still allowed: ' + progressPath);
    assert.equal(ok.stderr, '', 'and says nothing on stderr');
    const no = run(bash('cat .env'), guard);
    assert.equal(no.code, 2, 'and a dangerous one is still denied');
    assert.equal(no.stderr.split('\n').length, 1);
    assert.match(no.stderr, /^phantom guard: .+never-touch/);
  }
  assert.ok(!fs.existsSync(missingDir), 'the guard does not create directories');
});

test('a progress line is appended whole, so concurrent hooks cannot interleave', async () => {
  const { p, guard } = withProgress('progress-concurrent.jsonl');
  const { spawn } = require('node:child_process');
  const env = { ...process.env, PHANTOM_GUARD: JSON.stringify(guard) };
  // Twelve hook processes appending to one file at the same time -- exactly
  // what parallel tool calls look like. Every line must still parse.
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(bash('node --test test/case-' + i + '.test.js')));
  })));

  const lines = progressLines(p);
  assert.equal(lines.length, 12, 'no line was lost or split');
  assert.deepEqual([...new Set(lines.map((l) => l.tool))], ['Bash']);
  assert.deepEqual([...new Set(lines.map((l) => l.what))].length, 12, 'and each is intact and distinct');
});
