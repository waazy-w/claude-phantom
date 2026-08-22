'use strict';

const DEFAULT_TIMEOUT_MS = 5000;
const { commandLineOf } = require('./context');

/**
 * POST a JSON summary to the configured webhook. Best-effort: never throws,
 * never blocks recovery for more than `timeoutMs`.
 *
 * @param {string|null|undefined} url
 * @param {object} payload
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, skipped?: boolean }>}
 */
async function sendWebhook(url, payload, opts = {}) {
  if (!url) return { ok: false, skipped: true };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is not available in this Node version' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-phantom' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shape of the webhook body. Kept flat so Slack/Discord/Zapier-style
 * integrations can template it without nested lookups.
 */
function buildPayload(ctx, result) {
  return {
    event: 'phantom.recovery',
    status: result.status,
    command: commandLineOf(ctx),
    error: ctx.errorLine,
    exit: ctx.exitCode,
    signal: ctx.signal,
    branch: result.branch,
    report: result.reportPath,
    iterations: result.iterations,
    testsPassed: result.testsPassed,
    repo: ctx.git ? ctx.git.root : ctx.cwd,
    baseBranch: ctx.git ? ctx.git.branch : null,
    message: result.message,
    at: new Date().toISOString(),
  };
}

module.exports = { sendWebhook, buildPayload };
