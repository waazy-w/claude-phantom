'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotNeverTouch, diffSnapshots } = require('../src/audit');

const GLOBS = ['.env', '.env.*', '**/*.pem', '**/secrets/**', '.git/**', 'node_modules/**'];

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-audit-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'config', 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.phantom', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'A=1');
  fs.writeFileSync(path.join(root, 'src', '.env.local'), 'B=2');
  fs.writeFileSync(path.join(root, 'config', 'secrets', 'key.pem'), 'pem');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'code');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', '.env'), 'ignored');
  fs.writeFileSync(path.join(root, '.phantom', 'reports', 'x.pem'), 'ignored');
  return root;
}

test('snapshot lists only never-touch files outside skipped dirs', () => {
  const root = makeTree();
  const snap = snapshotNeverTouch(root, GLOBS, { skipPrefixes: ['.phantom'] });
  assert.deepEqual([...snap.keys()].sort(), ['.env', 'config/secrets/key.pem', 'src/.env.local']);
  assert.equal(typeof snap.get('.env').mtimeMs, 'number');
});

test('diffSnapshots reports modified, added and removed files', () => {
  const root = makeTree();
  const before = snapshotNeverTouch(root, GLOBS);
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'A=1;B=2');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(root, 'src', '.env.local'), past, past);
  fs.writeFileSync(path.join(root, '.env.production'), 'C=3');
  fs.unlinkSync(path.join(root, 'config', 'secrets', 'key.pem'));
  const after = snapshotNeverTouch(root, GLOBS);
  assert.deepEqual(diffSnapshots(before, after), {
    modified: ['.env', 'src/.env.local'],
    added: ['.env.production'],
    removed: ['config/secrets/key.pem'],
  });
});

test('identical trees produce an empty diff', () => {
  const root = makeTree();
  const a = snapshotNeverTouch(root, GLOBS);
  const b = snapshotNeverTouch(root, GLOBS);
  assert.deepEqual(diffSnapshots(a, b), { modified: [], added: [], removed: [] });
});

test('snapshot tolerates a missing root', () => {
  assert.equal(snapshotNeverTouch('/nonexistent/phantom/root', GLOBS).size, 0);
});
