'use strict';

const { slugify } = require('./crash');
const { readEvents, timeAgo, MAX_COMMAND_CHARS } = require('./events');
const gitmod = require('./git');
const { commandLineOf } = require('./context');

/**
 * Repeat-crash detection: "have we seen this before, and what should happen now?"
 *
 * The loop this exists to break: a bug crashes, phantom recovers it onto
 * `phantom/fix-<slug>-<suffix>`, and the user does not merge that branch right
 * away -- because they are still working. The next run crashes the same way, of
 * course it does, the fix is sitting on an unmerged branch. Phantom then paid
 * for a second full session, a second capture and a second post-mortem to
 * rediscover a fix it already has on disk. Three crashes in an hour was the
 * normal shape of that, not the pathological one.
 *
 * Nothing here writes. `.phantom/events.jsonl` is already the memory; this
 * module only reads it and answers a question.
 *
 * @typedef {import('./events').PhantomEvent} PhantomEvent
 *
 * @typedef {object} Grouping
 * @property {'slug'} by the key two crashes were grouped on
 * @property {string} slug
 * @property {boolean} weak true when the slug came from the exit code or signal
 *   rather than an error line, so it groups unrelated bugs together
 * @property {boolean} sameErrorLine the matched event carried the same error line
 * @property {boolean} sameCommand the matched event came from the same command
 * @property {string} note human-readable grouping reason, e.g. "same error line"
 *
 * @typedef {object} PriorLookup
 * @property {number} seen occurrences of this slug in the window, including this crash
 * @property {string} firstAt ISO, oldest occurrence in the window
 * @property {string} lastAt ISO, newest occurrence in the window (this crash)
 * @property {PhantomEvent|null} prior most recent *recovery* event for this slug
 * @property {boolean} branchAlive prior.branch exists and is unmerged
 * @property {string|null} priorReport prior.report, repo-relative, when the prior
 *   attempt failed and the next session should read it
 * @property {'fresh'|'suppress'|'retry-with-context'} verdict
 * @property {string} reason the sentence phantom prints
 * @property {Grouping} grouping
 */

/** Default lookback. A branch left unmerged over a weekend is not evidence. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Statuses where a session ran, learned something, and still did not fix it.
 * `aborted` and `refused` are excluded on purpose: nothing was learned, so
 * there is nothing to hand forward. `dry-run` is excluded because it never
 * verified anything -- passing an unverified diagnosis on as fact is how the
 * next session inherits a wrong theory instead of a dead end.
 */
const FAILED_STATUSES = new Set(['unfixed', 'timeout', 'error']);

/**
 * Slugs that carry no diagnostic content. `slugify` falls back to `exit-1` /
 * `signal-sigsegv` / `crash` when there is no error line, and those group every
 * unrelated failure of the same shape into one bucket -- two different bugs
 * that both make `npm test` exit 1 are one "error" under that key. Suppressing
 * on that grouping means a real, different bug silently never gets recovered,
 * so a weak slug is never allowed to reach a non-`fresh` verdict.
 */
const WEAK_SLUG_RE = /^(?:crash|exit-\d+|signal-[a-z0-9]+)$/;

/** Mirror events.js clamping so a long command compares equal to its stored form. */
function clampCommand(value) {
  if (typeof value !== 'string') return '';
  const oneLine = value.replace(/\s*[\r\n]+\s*/g, ' ');
  return oneLine.length <= MAX_COMMAND_CHARS ? oneLine : oneLine.slice(0, MAX_COMMAND_CHARS - 1) + '…';
}

/** The stored event's slug, recomputed the same way context.js computes ctx.slug. */
function slugOf(ev) {
  return slugify(ev.error, { signal: ev.signal, exitCode: ev.exit });
}

/**
 * Is the prior fix branch still holding the fix?
 *
 * Two conditions, and the second is what makes suppression self-clearing:
 * the branch must exist AND still have commits that HEAD does not. Merge it or
 * delete it and the next crash recovers normally -- there is no suppression
 * state anywhere to go stale, expire or clean up.
 *
 * `rev-list --count HEAD..<branch>` is used rather than `merge-base
 * --is-ancestor` because git.git() returns the empty string on success, which
 * is falsy: an ancestor check would read as "failed" at every call site.
 *
 * Being *on* the fix branch also counts as merged (HEAD..branch is empty), and
 * that is correct: if the code crashes the same way while the fix is checked
 * out, the fix did not work and the crash deserves a fresh session.
 */
function defaultBranchAlive(root, branch) {
  if (!branch) return false;
  if (!gitmod.branchExists(branch, { cwd: root })) return false;
  const ahead = gitmod.git(['rev-list', '--count', 'HEAD..' + branch], { cwd: root });
  return ahead !== null && Number(ahead) > 0;
}

/** "just now" / "58m ago" / "3h ago" as a duration: "a moment", "58m", "3h". */
function span(iso, now) {
  const ago = timeAgo(iso, now);
  return ago === 'just now' ? 'a moment' : ago.replace(' ago', '');
}

function groupingNote(grouping, matched) {
  if (grouping.weak) return 'grouped only by exit status (' + grouping.slug + '), which is too weak to act on';
  if (!matched) return 'same error slug (' + grouping.slug + ')';
  const head = grouping.sameErrorLine ? 'same error line' : 'same error slug (' + grouping.slug + ')';
  return grouping.sameCommand ? head : head + ', different command';
}

/**
 * Have we seen this crash before, and what should phantom do about it?
 *
 * Never throws. A missing, empty or corrupt event log yields `fresh`, which is
 * exactly phantom's behaviour before this module existed -- degrading to today
 * is always the safe answer for a module whose only power is to do less work.
 *
 * Safe to call on either side of the crash event being appended: occurrences
 * are counted strictly before `ctx.capturedAt`, so the current crash is counted
 * once whether or not it is already in the log. (It used to count the log
 * verbatim, which made `seen` depend on whether the caller ran before or after
 * `announceCrash` -- an off-by-one nobody could see from the call site.)
 *
 * @param {string} root repo root (the directory holding `.phantom/`)
 * @param {object} ctx crash context from gatherContext
 * @param {{ now?: number, windowMs?: number, events?: PhantomEvent[],
 *           branchAlive?: (root: string, branch: string) => boolean }} [opts]
 * @returns {PriorLookup}
 */
function lookupPrior(root, ctx, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const windowMs = opts.windowMs === undefined ? WINDOW_MS : opts.windowMs;
  const nowIso = new Date(now).toISOString();
  const slug = ctx && typeof ctx.slug === 'string' && ctx.slug
    ? ctx.slug
    : slugify(ctx && ctx.errorLine, ctx || {});
  const weak = WEAK_SLUG_RE.test(slug);
  const grouping = { by: 'slug', slug, weak, sameErrorLine: false, sameCommand: false, note: '' };
  const fresh = (reason) => {
    grouping.note = grouping.note || groupingNote(grouping, null);
    return { seen: 1, firstAt: nowIso, lastAt: nowIso, prior: null, branchAlive: false, priorReport: null, verdict: 'fresh', reason, grouping };
  };

  try {
    const events = opts.events || readEvents(root);
    // commandLineOf() is what events.js stored, redaction and all, so compare
    // through it rather than re-joining argv here.
    const command = clampCommand(ctx ? commandLineOf(ctx) : '');
    // The current crash's own event, if it has been written, carries `at >=
    // capturedAt`; every genuinely earlier occurrence is strictly before it.
    const cutoff = ctx && Number.isFinite(Date.parse(ctx.capturedAt)) ? Date.parse(ctx.capturedAt) : now;
    const floor = now - windowMs;

    const matches = [];
    for (const ev of events) {
      const t = Date.parse(ev.at);
      if (!Number.isFinite(t) || t < floor || t >= cutoff) continue;
      if (slugOf(ev) !== slug) continue;
      matches.push(ev);
    }
    if (!matches.length) return fresh('first time phantom has seen this error');

    const crashes = matches.filter((e) => e.type === 'crash');
    const recoveries = matches.filter((e) => e.type === 'recovery');
    const last = matches[matches.length - 1];
    grouping.sameErrorLine = Boolean(last.error) && last.error === (ctx && ctx.errorLine);
    grouping.sameCommand = Boolean(command) && last.command === command;
    grouping.note = groupingNote(grouping, last);

    // Sentry and Honeybadger converged on the same triple for a grouped error
    // -- times seen, first seen, last seen -- because those three answer "is
    // this getting worse?" without opening anything. This crash is the newest
    // sighting, so it is both the +1 and `lastAt`.
    const seen = crashes.length + 1;
    const firstAt = matches[0].at;
    const tally = 'seen ' + seen + '\u00d7 in the last ' + span(matches[0].at, now);
    const lastAt = nowIso;
    const prior = recoveries.length ? recoveries[recoveries.length - 1] : null;
    const base = { seen, firstAt, lastAt, prior, branchAlive: false, priorReport: null, verdict: 'fresh', reason: '', grouping };

    if (weak) {
      base.reason = tally + ', but ' + grouping.note;
      return base;
    }
    if (!prior) {
      base.reason = tally + ' (' + grouping.note + '), but no recovery has run yet';
      return base;
    }

    const branchAlive = prior.status === 'fixed'
      ? Boolean((opts.branchAlive || defaultBranchAlive)(root, prior.branch))
      : false;
    base.branchAlive = branchAlive;

    if (prior.status === 'fixed' && branchAlive) {
      base.verdict = 'suppress';
      base.reason = 'phantom already fixed this ' + timeAgo(prior.at, now) + ' on ' + prior.branch
        + ', and that branch is unmerged (' + tally + ', ' + grouping.note + ')'
        + '. Merge or delete the branch and phantom will recover it again.';
      return base;
    }
    if (FAILED_STATUSES.has(prior.status)) {
      base.verdict = 'retry-with-context';
      base.priorReport = prior.report || null;
      base.reason = 'phantom tried this ' + timeAgo(prior.at, now) + ' and ended ' + prior.status
        + ' (' + tally + ', ' + grouping.note + ')'
        + (base.priorReport ? '; handing the new session ' + base.priorReport : '; the last session left no report');
      return base;
    }
    // Fixed, but the branch is merged or gone -- the fix is in the tree and it
    // is still crashing, so this is new information and deserves a session.
    base.reason = prior.status === 'fixed'
      ? 'phantom fixed this ' + timeAgo(prior.at, now) + ', but that branch is merged or gone — recovering again'
      : 'last recovery of this error ended ' + prior.status + ' ' + timeAgo(prior.at, now) + ' — recovering again';
    return base;
  } catch {
    // Any surprise in the log is a reason to do today's thing, not to crash the
    // crash handler.
    return fresh('no usable history');
  }
}

module.exports = { lookupPrior, WINDOW_MS, FAILED_STATUSES, WEAK_SLUG_RE, defaultBranchAlive };
