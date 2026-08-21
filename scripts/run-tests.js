#!/usr/bin/env node
'use strict';

/**
 * Runs the test suite, portably.
 *
 * `node --test test/*.test.js` relies on the shell expanding the glob, which
 * cmd.exe does not do -- npm would hand node the literal string and it would
 * find nothing. `node --test test/` is not the fix either: in directory mode
 * node treats every .js file under a folder named `test` as a test file, so it
 * picks up test/fixtures/fake-claude.js, which blocks forever waiting on the
 * prompt it expects on stdin.
 *
 * So the list is built here and passed explicitly. Extra arguments are
 * forwarded, which is how `npm run test:watch` adds --watch.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const testDir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('test', f));

// A glob that matches nothing exits 0 and looks like a green suite; this must not.
if (!files.length) {
  console.error('no test files found in ' + testDir);
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});
child.on('error', (err) => { console.error(err.message); process.exit(1); });
child.on('close', (code, signal) => process.exit(signal ? 1 : code));
