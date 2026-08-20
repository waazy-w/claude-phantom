'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_MESSAGE_CHARS = 200;
const GROUP = 'claude-phantom';
const APP_NAME = 'phantom';

// CSI sequences (colours, cursor moves) and OSC sequences (hyperlinks, titles).
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Resolve a binary on PATH without shelling out. Mirrors `command -v`:
 * returns the first PATH entry that holds an executable of that name,
 * or null. Names containing a path separator are checked as-is.
 *
 * @param {string} bin
 * @param {object} [env]
 * @returns {string|null}
 */
function which(bin, env = process.env) {
  if (!bin || typeof bin !== 'string') return null;
  const isWin = process.platform === 'win32';
  const exts = isWin ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const candidates = (name) => (isWin && !path.extname(name) ? exts.map((e) => name + e) : [name]);

  if (bin.includes('/') || (isWin && bin.includes('\\'))) {
    for (const c of candidates(path.resolve(bin))) if (isExecutable(c)) return c;
    return null;
  }
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const c of candidates(path.join(dir, bin))) if (isExecutable(c)) return c;
  }
  return null;
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a string safe for a one-line notification: strip ANSI, collapse
 * newlines and runs of whitespace, optionally cap the length.
 */
function clean(value, max) {
  let s = value == null ? '' : String(value);
  s = s.replace(ANSI_RE, '').replace(/[\r\n\t\f\v]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

/** Quote a value as an AppleScript string literal (only `\` and `"` are special). */
function appleScriptString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Run a notifier binary and resolve with a result object. Never rejects.
 */
function run(spawnImpl, bin, args, via, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawnImpl(bin, args, { stdio: 'ignore', detached: false });
    } catch (err) {
      return finish({ ok: false, via, error: String(err && err.message || err) });
    }
    if (!child || typeof child.on !== 'function') {
      return finish({ ok: false, via, error: 'spawn returned no child process' });
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, via, error: 'timeout' });
    }, timeoutMs);

    child.on('error', (err) => finish({ ok: false, via, error: String(err && err.message || err) }));
    child.on('exit', (code, signal) => {
      if (code === 0) finish({ ok: true, via });
      else finish({ ok: false, via, error: signal ? `killed by ${signal}` : `exit code ${code}` });
    });
  });
}

/**
 * Best-effort OS notification. Never throws, never blocks longer than timeoutMs.
 *
 * darwin: terminal-notifier if installed, else osascript `display notification`.
 * linux:  notify-send if installed, else skipped.
 * other:  skipped.
 *
 * @param {{ title: string, message: string, subtitle?: string, icon?: string }} n  icon = absolute path to a PNG
 * @param {{ platform?: string, env?: object, spawn?: Function, which?: (bin: string) => string|null, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, via?: 'terminal-notifier'|'osascript'|'notify-send', skipped?: boolean, error?: string }>}
 */
async function send(n, opts = {}) {
  try {
    const platform = opts.platform || process.platform;
    if (platform !== 'darwin' && platform !== 'linux') return { ok: false, skipped: true };

    const env = opts.env || process.env;
    const spawnImpl = opts.spawn || require('node:child_process').spawn;
    const resolveBin = opts.which || ((bin) => which(bin, env));
    const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    const src = n || {};
    const title = clean(src.title) || GROUP;
    const message = clean(src.message, MAX_MESSAGE_CHARS);
    const subtitle = clean(src.subtitle);
    const icon = typeof src.icon === 'string' && src.icon && fs.existsSync(src.icon) ? src.icon : null;

    if (platform === 'darwin') {
      const tn = resolveBin('terminal-notifier');
      if (tn) {
        const args = ['-title', title, '-message', message];
        if (subtitle) args.push('-subtitle', subtitle);
        if (icon) args.push('-appIcon', icon, '-contentImage', icon);
        args.push('-group', GROUP);
        return run(spawnImpl, tn, args, 'terminal-notifier', timeoutMs);
      }
      let script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
      if (subtitle) script += ` subtitle ${appleScriptString(subtitle)}`;
      return run(spawnImpl, resolveBin('osascript') || 'osascript', ['-e', script], 'osascript', timeoutMs);
    }

    // linux
    const ns = resolveBin('notify-send');
    if (!ns) return { ok: false, skipped: true };
    const args = [];
    if (icon) args.push('-i', icon);
    args.push('-a', APP_NAME, title, message);
    return run(spawnImpl, ns, args, 'notify-send', timeoutMs);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = { send, which, DEFAULT_TIMEOUT_MS };
