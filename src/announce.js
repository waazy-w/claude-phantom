'use strict';

const path = require('node:path');
const events = require('./events');
const git = require('./git');
const { log } = require('./ui');

const ICON = path.join(__dirname, '..', 'brand', 'png', 'favicon-512.png');

/**
 * Tell the outside world what happened: append to the event log (read by the
 * Claude Code plugin hook and `phantom-status`) and, when `config.notify` is
 * on, raise a desktop notification. Everything here is best-effort and must
 * never delay or break recovery.
 *
 * @param {object} ctx crash context
 * @param {object} config
 * @param {string} root repository root
 * @param {{ notifier?: { send: Function } }} [deps]
 */
async function announceCrash(ctx, config, root, deps = {}) {
  // The event log must never make the tree look dirty to the next phantom run.
  git.ensureExcluded(root, '.phantom');
  const ev = events.appendEvent(root, events.crashEvent(ctx));
  if (config && config.notify) {
    await notifyDesktop({
      title: '👻 phantom: crash detected',
      subtitle: ev ? ev.command : undefined,
      message: (ctx.errorLine || 'exit ' + ctx.exitCode) + ' — phantom is taking over',
    }, deps);
  }
  return ev;
}

/**
 * @param {object} ctx
 * @param {object} config
 * @param {{ status: string, branch: string|null, reportPath: string|null, message: string }} final
 * @param {string} root
 * @param {{ notifier?: { send: Function } }} [deps]
 */
async function announceRecovery(ctx, config, final, root, deps = {}) {
  const ev = events.appendEvent(root, events.recoveryEvent(ctx, final, root));
  if (config && config.notify) {
    const headline = {
      fixed: 'fixed',
      'dry-run': 'dry run finished',
      unfixed: 'could not fix it',
      aborted: 'recovery aborted',
    }[final.status] || final.status;
    await notifyDesktop({
      title: '👻 phantom: ' + headline,
      subtitle: ev ? ev.command : undefined,
      message: final.branch ? 'branch ' + final.branch : (final.message || ''),
    }, deps);
  }
  return ev;
}

// Said once per run, not per notification: two identical warnings around one
// recovery would be worse than the silence they are explaining.
let warnedAboutOsascript = false;

/**
 * On macOS 14+ a `display notification` from a plain CLI is dropped without the
 * script ever appearing under System Settings → Notifications, and osascript
 * still exits 0 -- so `--notify` looks like it works and nothing arrives, with
 * nothing phantom can observe to tell the difference. terminal-notifier ships
 * its own bundle and does register, so it is the path that actually delivers.
 */
async function notifyDesktop(n, deps) {
  try {
    const notifier = deps.notifier || require('./desktop-notify');
    const r = await notifier.send(Object.assign({ icon: ICON }, n));
    if (r && r.via === 'osascript' && !warnedAboutOsascript) {
      warnedAboutOsascript = true;
      log.warn('desktop notifications are going through osascript, which recent macOS drops silently'
        + ' — run `brew install terminal-notifier` if you saw nothing');
    }
    return r;
  } catch {
    return { ok: false, error: 'notifier unavailable' };
  }
}

module.exports = { announceCrash, announceRecovery, ICON };
