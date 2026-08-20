'use strict';
// Helper: wraps a node child through runCommand and prints the RunResult as JSON.
// Used by the signal-forwarding tests, which send signals to this process.
const { runCommand } = require('../../src/watcher');
const { Writable } = require('node:stream');

const mode = process.argv[2] || 'idle';
const scripts = {
  idle: 'setInterval(() => {}, 1000); console.log("started")',
  ignoreSigint: 'process.on("SIGINT", () => {}); setInterval(() => {}, 1000); console.log("started")',
};
const sink = new Writable({ write(c, e, cb) { cb(); } });
const p = runCommand(process.execPath, ['-e', scripts[mode]], {
  stdout: sink,
  stderr: sink,
  killGraceMs: Number(process.env.KILL_GRACE_MS || 300),
});
p.child.stdout.once('data', () => process.send && process.send('ready'));
p.then((r) => {
  process.stdout.write(JSON.stringify(r) + '\n');
}, (err) => {
  process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
});
