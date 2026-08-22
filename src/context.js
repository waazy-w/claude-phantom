'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crash = require('./crash');
const git = require('./git');
const { isNeverTouch } = require('./never-touch');
const { redact } = require('./redact');
const { stripAnsi } = require('./ansi');

/** @typedef {import('./watcher').RunResult} RunResult */
/** @typedef {import('./config').Config} Config */

/**
 * @typedef {RunResult & {
 *   crashed: true,
 *   stackTrace: string|null,
 *   errorLine: string|null,
 *   hintFiles: string[],
 *   slug: string,
 *   redactions: number,
 *   git: { root: string, branch: string, detached: boolean, headSha: string, dirty: boolean,
 *          status: string, recentCommits: string[] } | null,
 *   pkg: { name?: string, scripts?: Record<string,string> } | null,
 *   testCommand: string|null,
 *   capturedAt: string
 * }} CrashContext
 */

function readPackage(dirs) {
  for (const dir of dirs) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (!data || typeof data !== 'object') continue;
      const pkg = {};
      if (typeof data.name === 'string') pkg.name = data.name;
      if (data.scripts && typeof data.scripts === 'object') pkg.scripts = { ...data.scripts };
      return pkg;
    } catch {
      /* missing or unparsable: try the next directory */
    }
  }
  return null;
}

function gitInfo(cwd) {
  const root = git.root({ cwd });
  if (!root) return null;
  const headSha = git.headSha({ cwd }) || '';
  const branch = git.currentBranch({ cwd });
  return {
    root,
    // Detached HEAD: the sha doubles as the ref to return to.
    branch: branch || headSha || 'HEAD',
    detached: !branch,
    headSha,
    dirty: git.isDirty({ cwd }),
    status: git.status({ cwd }) || '',
    recentCommits: git.recentCommits(10, { cwd }),
  };
}

/**
 * The crashed command as a single string, safe to display.
 *
 * `command` and `args` stay raw on the context because reproduce() re-runs
 * them, so anything that SHOWS the command has to come through here instead:
 * a wrapped command routinely carries credentials in argv
 * (`node server.js --api-key=...`), and those went verbatim into the model
 * prompt, the post-mortem, the crash JSON, the desktop notification and the
 * webhook POST -- the one destination that leaves the machine. The tail beside
 * them was scrubbed all along; argv simply was never passed through redact().
 *
 * @param {{ command: string, args?: string[], commandLine?: string }} ctx
 * @returns {string}
 */
const commandLineOf = (ctx) => (
  typeof ctx.commandLine === 'string'
    ? ctx.commandLine
    : redact([ctx.command, ...(ctx.args || [])].join(' ')).text
);

/**
 * Builds the crash context. The output tail is scrubbed of secret-looking
 * values here, at the source, so nothing downstream (crash JSON on disk,
 * prompt, fallback report, webhook) ever sees the raw value.
 * @param {RunResult} runResult
 * @param {Config} config
 * @returns {CrashContext}
 */
function gatherContext(runResult, config) {
  const cwd = runResult.cwd || process.cwd();
  // Strip escapes before redacting: a colour code inside a token would hide it
  // from the secret patterns, and every consumer of the tail wants plain text.
  const scrubbed = redact(stripAnsi(runResult.tail));
  const tail = scrubbed.text;
  const info = gitInfo(cwd);
  const base = info ? info.root : cwd;
  const dirs = [...new Set([cwd, base])];
  const prefixes = new Set(dirs);
  for (const d of dirs) {
    try { prefixes.add(fs.realpathSync(d)); } catch { /* unreadable: skip */ }
  }
  const { stackTrace, errorLine, hintFiles } = crash.extractStackTrace(tail, {
    cwd: base,
    extraPrefixes: [...prefixes].filter((d) => d !== base),
  });
  const pkg = readPackage(dirs);
  const neverTouch = (config && config.neverTouch) || [];
  return {
    ...runResult,
    tail,
    commandLine: redact([runResult.command, ...(runResult.args || [])].join(' ')).text,
    crashed: true,
    redactions: scrubbed.redactions,
    stackTrace,
    errorLine,
    hintFiles: hintFiles.filter((f) => !isNeverTouch(f, neverTouch)),
    slug: crash.slugify(errorLine, runResult),
    git: info,
    pkg,
    testCommand: (config && config.testCommand) || (pkg && pkg.scripts && pkg.scripts.test ? 'npm test' : null),
    capturedAt: new Date().toISOString(),
  };
}

module.exports = { gatherContext, commandLineOf };
