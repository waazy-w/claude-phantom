'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { globToRegExp, isNeverTouch } = require('../src/never-touch');

const hit = (glob, p) => isNeverTouch(p, [glob]);

test('patterns without a slash match in any directory', () => {
  assert.ok(hit('.env', '.env'));
  assert.ok(hit('.env', 'sub/.env'));
  assert.ok(hit('.env', 'a/b/c/.env'));
  assert.ok(!hit('.env', '.env.local'));
  assert.ok(!hit('.env', 'env'));
  assert.ok(hit('*.pem', 'certs/server.pem'));
});

test('.env.* matches .env.local but not .envrc', () => {
  assert.ok(hit('.env.*', '.env.local'));
  assert.ok(hit('.env.*', 'config/.env.production'));
  assert.ok(!hit('.env.*', '.envrc'));
  assert.ok(!hit('.env.*', '.env'));
});

test('** spans directories, * does not', () => {
  assert.ok(hit('**/*.pem', 'server.pem'));
  assert.ok(hit('**/*.pem', 'a/b/server.pem'));
  assert.ok(hit('**/secrets/**', 'secrets/x.json'));
  assert.ok(hit('**/secrets/**', 'app/secrets/deep/x.json'));
  assert.ok(hit('**/secrets/**', 'app/secrets'));
  assert.ok(!hit('**/secrets/**', 'app/secretsX/x.json'));
  assert.ok(hit('src/*.js', 'src/a.js'));
  assert.ok(!hit('src/*.js', 'src/sub/a.js'));
  assert.ok(hit('**/*.secret*', 'deploy/prod.secret.yaml'));
});

test('? and {a,b} alternation, ./ normalization, always-never-touch', () => {
  assert.ok(hit('file?.txt', 'file1.txt'));
  assert.ok(!hit('file?.txt', 'file10.txt'));
  assert.ok(hit('*.{pem,key}', 'a/id.key'));
  assert.ok(hit('*.{pem,key}', 'id.pem'));
  assert.ok(!hit('*.{pem,key}', 'id.pub'));
  assert.ok(hit('./src/x.js', 'src/x.js'));
  assert.ok(hit('src/x.js', './src/x.js'));
  assert.ok(hit('.git/**', '.git/config'));
  assert.ok(hit('node_modules/**', 'node_modules/a/index.js'));
  assert.ok(!hit('node_modules/**', 'src/node_modules.js'));
  assert.ok(isNeverTouch('a\\.env', ['.env']));
  assert.ok(!isNeverTouch('src/index.js', ['.env', '**/*.pem', '.git/**']));
});

test('globToRegExp escapes regex metacharacters', () => {
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'));
  assert.ok(globToRegExp('a+b(1)').test('a+b(1)'));
});

test('matching is case-insensitive (macOS/Windows resolve .ENV to .env)', () => {
  assert.ok(hit('.env', '.ENV'));
  assert.ok(hit('.env.*', 'config/.Env.Production'));
  assert.ok(hit('**/*.pem', 'certs/SERVER.PEM'));
  assert.ok(hit('**/secrets/**', 'app/Secrets/x.json'));
});
