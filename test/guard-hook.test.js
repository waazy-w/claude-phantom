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

function run(event, guard = baseGuard, { rawStdin, noGuard } = {}) {
  const env = { ...process.env };
  delete env.PHANTOM_GUARD;
  if (!noGuard) env.PHANTOM_GUARD = JSON.stringify(guard);
  const r = spawnSync(process.execPath, [HOOK], { input: rawStdin !== undefined ? rawStdin : JSON.stringify(event), env, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr.trim(), stdout: r.stdout };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd, hook_event_name: 'PreToolUse' });
const file = (tool, file_path) => ({ tool_name: tool, tool_input: { file_path }, cwd, hook_event_name: 'PreToolUse' });

test('fails closed on malformed input', () => {
  assert.equal(run(null, baseGuard, { rawStdin: 'not json' }).code, 2);
  assert.match(run(null, baseGuard, { rawStdin: '' }).stderr, /could not parse hook input/);
  assert.match(run(bash('ls'), baseGuard, { noGuard: true }).stderr, /PHANTOM_GUARD/);
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
