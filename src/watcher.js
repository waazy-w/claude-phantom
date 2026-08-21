'use strict';

/**
 * Spawns the wrapped command and streams its output through untouched.
 *
 * stdout/stderr are piped (not inherited) so the tail can be captured, which
 * means the child sees a pipe rather than a TTY and some tools (chalk, npm,
 * vite, ...) drop colors. The environment is passed through unmodified; users
 * who want colors back should set FORCE_COLOR=1 themselves (README note).
 * stdin is inherited so interactive children keep working.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RingBuffer } = require('./ring-buffer');

/**
 * @typedef {object} RunResult
 * @property {string} command
 * @property {string[]} args
 * @property {string} cwd
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {number} startedAt epoch ms
 * @property {number} endedAt epoch ms
 * @property {number} durationMs
 * @property {string} tail ring buffer contents, stdout+stderr in arrival order
 * @property {boolean} userInterrupted phantom itself received SIGINT/SIGTERM/SIGHUP
 */

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const DEFAULT_RING_BYTES = 262144;
const DEFAULT_KILL_GRACE_MS = 5000;

class SpawnError extends Error {
  constructor(command, cause) {
    const notFound = cause && cause.code === 'ENOENT';
    super(notFound ? 'command not found: ' + command : 'failed to start ' + command + ': ' + (cause && cause.message));
    this.name = 'SpawnError';
    this.code = cause && cause.code;
    this.command = command;
    this.cause = cause;
    this.exitCode = notFound ? 127 : 126;
  }
}

const WINDOWS_BATCH = /\.(?:bat|cmd)$/i;
const CMD_META = /([()[\]%!^"`<>&|;, *?])/g;

/**
 * Resolves `command` against PATH the way Windows would, PATHEXT included, so a
 * batch shim (npm.cmd, npx.cmd, ...) can be told apart from a real executable.
 * @returns {string|null} the resolved file, or null when nothing matches
 */
function resolveWindowsCommand(command, cwd, env) {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = path.extname(command) ? [command] : exts.map((ext) => command + ext);
  // A command with a separator in it is a path, never a PATH lookup. PATH
  // entries themselves may be quoted when they contain spaces.
  const dirs = /[\\/]/.test(command)
    ? [cwd]
    : (env.Path || env.PATH || '').split(';').map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      try {
        const full = path.resolve(dir, name);
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        if (stat && stat.isFile()) return full;
      } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

/**
 * Escapes one argument for a `cmd.exe /d /s /c "..."` line. The value is first
 * quoted for the target's C runtime, then every character cmd itself would act
 * on is caret-escaped -- after the quotes, so nothing is left inside a region
 * cmd sees as quoted. Batch files parse their own line a second time, hence the
 * second pass. Algorithm from https://qntm.org/cmd, as used by cross-spawn.
 */
function escapeArgForCmd(arg) {
  const quoted = '"' + String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, ringBufferBytes?: number,
 *           stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream,
 *           onSignal?: (signal: string) => void, killGraceMs?: number }} [opts]
 * @returns {Promise<RunResult> & { child: import('node:child_process').ChildProcess|null, kill: (signal?: string) => boolean }}
 */
function runCommand(command, args = [], opts = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    ringBufferBytes = DEFAULT_RING_BYTES,
    stdout = process.stdout,
    stderr = process.stderr,
    onSignal,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
  } = opts;
  const ring = new RingBuffer(ringBufferBytes);
  const startedAt = Date.now();
  let child = null;
  let userInterrupted = false;
  let settled = false;

  const promise = new Promise((resolve, reject) => {
    // Only .cmd/.bat shims (npm, npx, ...) need cmd.exe; sending everything
    // through it -- which is what `shell: true` does -- lets cmd re-parse the
    // argv and strip the quotes out of arguments like -e 'console.log("hi")'.
    const { file, argv, opts: winOpts } = windowsSafeSpawn(command, args, cwd, env);
    try {
      child = spawn(file, argv, {
        cwd,
        env,
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        ...winOpts,
      });
    } catch (err) {
      reject(new SpawnError(command, err));
      return;
    }

    const pump = (src, dest) => {
      if (!src) return;
      src.on('data', (chunk) => ring.push(chunk));
      src.pipe(dest, { end: false });
      const onDestError = () => { src.unpipe(dest); };
      dest.once('error', onDestError);
      src.once('end', () => dest.removeListener('error', onDestError));
    };
    pump(child.stdout, stdout);
    pump(child.stderr, stderr);

    let killTimer = null;
    const handlers = new Map();
    const forward = (signal) => {
      userInterrupted = true;
      if (onSignal) onSignal(signal);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal); } catch { /* already gone */ }
        if (!killTimer) {
          killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          }, killGraceMs);
          killTimer.unref();
        }
      }
    };
    for (const sig of FORWARDED_SIGNALS) {
      const h = () => forward(sig);
      handlers.set(sig, h);
      process.on(sig, h);
    }
    const cleanup = () => {
      for (const [sig, h] of handlers) process.removeListener(sig, h);
      if (killTimer) clearTimeout(killTimer);
    };

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SpawnError(command, err));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const endedAt = Date.now();
      resolve({
        command,
        args: [...args],
        cwd,
        exitCode: code,
        signal,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        tail: ring.toString(),
        userInterrupted,
      });
    });
  });

  promise.child = child;
  promise.kill = (signal = 'SIGTERM') => (child ? child.kill(signal) : false);
  return promise;
}

/**
 * Exit code the CLI should use for a finished child: the child's own code, or
 * 128 + signal number when it died from a signal.
 * @param {Partial<RunResult>} runResult
 * @returns {number}
 */
function exitCodeFor(runResult) {
  if (runResult.exitCode !== null && runResult.exitCode !== undefined) return runResult.exitCode;
  if (runResult.signal) {
    const num = os.constants.signals[runResult.signal];
    return num ? 128 + num : 1;
  }
  return 1;
}

/**
 * How to spawn `command` on this platform without a shell re-parsing the argv.
 * Returns the file and argv to hand to spawn, plus any extra spawn options.
 * On anything but win32 this is the identity; on win32 a resolved .cmd/.bat
 * shim is routed through cmd.exe with each argument escaped, and everything
 * else -- including a command that resolves to nothing, so spawn still reports
 * ENOENT -- is spawned directly.
 * @returns {{ file: string, argv: string[], opts: object }}
 */
function windowsSafeSpawn(command, args, cwd, env) {
  if (process.platform !== 'win32') return { file: command, argv: args, opts: {} };
  const resolved = resolveWindowsCommand(command, cwd, env);
  if (!resolved || !WINDOWS_BATCH.test(resolved)) return { file: command, argv: args, opts: {} };
  const line = [resolved.replace(CMD_META, '^$1'), ...args.map(escapeArgForCmd)].join(' ');
  return {
    file: env.ComSpec || env.comspec || process.env.ComSpec || 'cmd.exe',
    argv: ['/d', '/s', '/c', '"' + line + '"'],
    opts: { windowsVerbatimArguments: true },
  };
}

module.exports = {
  runCommand, exitCodeFor, SpawnError, FORWARDED_SIGNALS,
  windowsSafeSpawn, resolveWindowsCommand, escapeArgForCmd,
};
