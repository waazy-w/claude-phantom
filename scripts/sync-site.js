#!/usr/bin/env node
'use strict';

/**
 * Rewrite the version and test count in site/index.html from the source of
 * truth: package.json, and an actual test run.
 *
 * These numbers were hand-edited, which meant the site quietly fell a release
 * behind every time someone forgot -- and a marketing page advertising the
 * wrong version is worse than one advertising none. Run with --check in CI to
 * fail instead of writing.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const sitePath = path.join(root, 'site', 'index.html');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const run = spawnSync(process.execPath, [path.join(__dirname, 'run-tests.js')], { cwd: root, encoding: 'utf8' });
const match = (run.stdout + run.stderr).match(/(?:ℹ|#) tests (\d+)/);
if (!match) {
  console.error('could not read a test count from the suite output');
  process.exit(1);
}
const tests = match[1];

const before = fs.readFileSync(sitePath, 'utf8');
const after = before
  .replace(/v<b>[0-9][0-9.]*<\/b>/g, 'v<b>' + version + '</b>')
  .replace(/claude-phantom [0-9][0-9.]* — MIT/g, 'claude-phantom ' + version + ' — MIT')
  .replace(/<span class="badge">\d+ tests<\/span>/g, '<span class="badge">' + tests + ' tests</span>');

/**
 * The plugin and marketplace manifests carry their own version fields, which
 * drifted to 0.1.0 while the package reached 0.3.3 -- nobody edits four files
 * by hand for a patch release. They track package.json like everything else.
 */
function pluginManifests() {
  const files = [
    path.join(root, 'plugin', '.claude-plugin', 'plugin.json'),
    path.join(root, '.claude-plugin', 'marketplace.json'),
  ];
  return files.filter((f) => fs.existsSync(f)).map((f) => {
    const text = fs.readFileSync(f, 'utf8');
    return [f, { text, updated: text.replace(/"version":\s*"[0-9][0-9.]*"/g, '"version": "' + version + '"') }];
  });
}

const staleManifests = () => pluginManifests().filter(([, w]) => w.text !== w.updated).map(([f]) => path.relative(root, f));

if (process.argv.includes('--check')) {
  const stale = staleManifests();
  if (stale.length) {
    console.error('stale version in: ' + stale.join(', ') + ' (expected ' + version + ')');
    console.error('run: npm run sync-site');
    process.exit(1);
  }
  if (before !== after) {
    console.error('site/index.html is stale: expected v' + version + ' and ' + tests + ' tests');
    console.error('run: npm run sync-site');
    process.exit(1);
  }
  console.log('site is current: v' + version + ', ' + tests + ' tests');
  return;
}

fs.writeFileSync(sitePath, after);
console.log(before === after ? 'site already current' : 'site updated to v' + version + ', ' + tests + ' tests');

for (const [file, was] of pluginManifests()) {
  if (was.text !== was.updated) {
    fs.writeFileSync(file, was.updated);
    console.log(path.relative(root, file) + ' updated to v' + version);
  }
}
