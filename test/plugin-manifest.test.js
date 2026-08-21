'use strict';

/**
 * The Claude Code plugin manifests.
 *
 * These are shipped in the npm tarball and consumed by `/plugin install`, and
 * nothing else in the suite reads them -- so the plugin was broken from the day
 * it was written and stayed broken across four releases. The manifest declared
 * `"hooks": "./hooks/hooks.json"`, which Claude Code already loads by
 * convention, and registering it twice fails the whole plugin with "Duplicate
 * hooks file detected". Installing it reported success; only `/plugin` showed
 * the error.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));

const PLUGIN = ['plugin', '.claude-plugin', 'plugin.json'];
const MARKETPLACE = ['.claude-plugin', 'marketplace.json'];

test('the plugin manifest does not re-declare files Claude Code loads by convention', () => {
  const manifest = readJson(...PLUGIN);
  // hooks/hooks.json is loaded automatically. `hooks` in the manifest is for
  // ADDITIONAL files, so naming the standard one registers it twice and the
  // plugin fails to load entirely -- the exact bug this file exists to prevent.
  const standard = path.join(root, 'plugin', 'hooks', 'hooks.json');
  assert.ok(fs.existsSync(standard), 'the conventional hooks file is where Claude Code expects it');

  if (manifest.hooks !== undefined) {
    const declared = [].concat(manifest.hooks).map((h) => path.resolve(root, 'plugin', h));
    assert.ok(!declared.includes(standard),
      'manifest.hooks must not name hooks/hooks.json — Claude Code already loads it, and the duplicate fails the plugin');
  }
});

test('the plugin manifest has what an install needs, and points at files that exist', () => {
  const manifest = readJson(...PLUGIN);
  assert.equal(manifest.name, 'phantom');
  assert.ok(manifest.description && manifest.description.length > 20, 'a description users will read');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  for (const [key, expected] of [['skills', 'skills'], ['commands', 'commands']]) {
    if (manifest[key] === undefined) continue;
    const dir = path.resolve(root, 'plugin', manifest[key]);
    assert.ok(fs.existsSync(dir), key + ' points at a directory that exists: ' + manifest[key]);
    assert.ok(fs.readdirSync(dir).length, key + ' directory is not empty');
    assert.equal(path.basename(dir), expected);
  }
});

test('the hooks file is valid and every command it names exists', () => {
  const hooks = readJson('plugin', 'hooks', 'hooks.json');
  const events = Object.keys(hooks.hooks || {});
  assert.ok(events.includes('UserPromptSubmit'), 'the briefing needs a prompt hook');
  assert.ok(events.includes('SessionStart'), 'and one at session start');

  // ${CLAUDE_PLUGIN_ROOT} is substituted by Claude Code; resolve it ourselves so
  // a renamed or deleted script fails here rather than silently at runtime.
  const scripts = JSON.stringify(hooks).match(/\$\{CLAUDE_PLUGIN_ROOT\}\/[^"\\ ]+/g) || [];
  assert.ok(scripts.length, 'at least one hook command');
  for (const s of scripts) {
    const rel = s.replace('${CLAUDE_PLUGIN_ROOT}/', '');
    assert.ok(fs.existsSync(path.join(root, 'plugin', rel)), 'hook script exists: ' + rel);
  }
});

test('the marketplace entry resolves to the plugin and carries the same version', () => {
  const market = readJson(...MARKETPLACE);
  const manifest = readJson(...PLUGIN);
  const pkg = readJson('package.json');

  assert.equal(market.name, 'claude-phantom', 'this is the name users type after /plugin marketplace add');
  const entry = (market.plugins || []).find((p) => p.name === 'phantom');
  assert.ok(entry, 'the marketplace lists the plugin');
  assert.ok(fs.existsSync(path.resolve(root, entry.source, '.claude-plugin', 'plugin.json')),
    'entry.source points at a directory holding a plugin manifest: ' + entry.source);

  // Drifted to 0.1.0 while the package reached 0.3.3, because nobody edits four
  // version fields by hand. scripts/sync-site.js keeps them together now.
  assert.equal(manifest.version, pkg.version, 'plugin.json version tracks package.json');
  assert.equal(entry.version, pkg.version, 'marketplace entry version tracks package.json');
});

test('the plugin ships in the npm tarball', () => {
  // `files` decides what a user actually receives; a plugin left out of it is
  // installable only from GitHub, which is not what the README promises.
  const pkg = readJson('package.json');
  assert.ok((pkg.files || []).includes('plugin'), 'package.json files includes the plugin directory');
});
