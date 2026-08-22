'use strict';

/**
 * Repeat-crash detection.
 *
 * The bug this exists for: the same error crashes three times in an hour and
 * phantom runs three full sessions, leaving three near-identical branches and
 * three bills. That is the NORMAL shape of a dev loop, because the fix is
 * sitting on an unmerged branch -- so of course the next run crashes the same
 * way.
 *
 * The design constraint that matters most is that suppression must be
 * SELF-CLEARING. Phantom declining to recover is a change to the "wrap it and
 * forget" contract, so the only safe gate is one the user can clear by doing
 * the obvious thing: merge the branch, or delete it. Every test below is
 * ultimately checking that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const events = require('../src/events');
const { lookupPrior, WINDOW_MS, FAILED_STATUSES } = require('../src/history');

const T0 = Date.parse('2026-08-22T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'phantom-hist-'));

/** A crash context with a strong, specific slug. */
const ctxFor = (slug = 'typeerror-cannot-read-properties', over = {}) => ({
  slug,
  command: 'node',
  args: ['src/app.js'],
  errorLine: "TypeError: Cannot read properties of undefined (reading 'value')",
  exitCode: 1,
  ...over,
});

/** Append a crash, then a recovery that ended `status`, `minsAgo` in the past. */
function record(root, ctx, status, branch, minsAgo, over = {}) {
  const at = T0 - minsAgo * 60000;
  events.appendEvent(root, {
    type: 'crash', command: 'node src/app.js', error: ctx.errorLine, exit: 1, signal: null, slug: ctx.slug,
  }, { now: at });
  if (!status) return;
  events.appendEvent(root, {
    type: 'recovery', command: 'node src/app.js', error: ctx.errorLine, exit: 1, signal: null,
    slug: ctx.slug, status, branch, report: '.phantom/reports/x.md', message: 'm', ...over,
  }, { now: at + 1000 });
}

/** Pretend `alive` branches still exist and are unmerged. */
const branchAliveStub = (alive) => (root, branch) => alive.includes(branch);

test('a first crash is always fresh, whatever the log says', () => {
  const root = tmp();
  const r = lookupPrior(root, ctxFor(), { now: T0 });
  assert.equal(r.verdict, 'fresh');
  assert.equal(r.seen, 1);
  assert.equal(r.prior, null);
  assert.match(r.reason, /\S/, 'a reason is always given, so phantom can say why');
});

test('a fixed branch that is still unmerged suppresses the next identical crash', () => {
  // The whole point: the fix already exists and has not been taken, so of
  // course it still crashes. Running a second session buys nothing.
  const root = tmp();
  const ctx = ctxFor();
  record(root, ctx, 'fixed', 'phantom/fix-typeerror-abc12', 12);

  const r = lookupPrior(root, ctx, { now: T0, branchAlive: branchAliveStub(['phantom/fix-typeerror-abc12']) });
  assert.equal(r.verdict, 'suppress');
  assert.equal(r.branchAlive, true);
  assert.equal(r.prior.branch, 'phantom/fix-typeerror-abc12');
  assert.match(r.reason, /phantom\/fix-typeerror-abc12/, 'the message names the branch');
  assert.match(r.reason, /[Mm]erge or delete/, 'and says how to clear it');
});

test('merging or deleting that branch clears the suppression by itself', () => {
  // No state to clean up, nothing to expire: the gate IS the branch. This is
  // what makes it safe to change the "wrap it and forget" contract at all.
  const root = tmp();
  const ctx = ctxFor();
  record(root, ctx, 'fixed', 'phantom/fix-typeerror-abc12', 12);

  const gone = lookupPrior(root, ctx, { now: T0, branchAlive: branchAliveStub([]) });
  assert.equal(gone.verdict, 'fresh', 'branch merged or deleted -> recover normally again');
  assert.equal(gone.branchAlive, false);
  assert.match(gone.reason, /merged or gone/);
});

test('a failed prior attempt is not suppressed -- it hands over what was learned', () => {
  // Rediscovering the same dead end is the waste here, not the second session.
  const root = tmp();
  const ctx = ctxFor();
  for (const status of FAILED_STATUSES) {
    const r0 = tmp();
    record(r0, ctx, status, 'phantom/fix-typeerror-abc12', 5);
    const r = lookupPrior(r0, ctx, { now: T0, branchAlive: branchAliveStub(['phantom/fix-typeerror-abc12']) });
    assert.equal(r.verdict, 'retry-with-context', status + ' must still recover');
    assert.equal(r.priorReport, '.phantom/reports/x.md', 'and carry the previous report forward');
    assert.match(r.reason, new RegExp(status));
  }
  assert.ok(FAILED_STATUSES.size >= 2, 'more than one failing status is covered: ' + [...FAILED_STATUSES].join(','));
});

test('the count, first-seen and last-seen are reported the way error trackers report them', () => {
  // Sentry and Honeybadger both settled on this triple for a grouped error.
  const root = tmp();
  const ctx = ctxFor();
  record(root, ctx, null, null, 90);
  record(root, ctx, null, null, 45);
  record(root, ctx, 'fixed', 'phantom/fix-typeerror-abc12', 10);

  const r = lookupPrior(root, ctx, { now: T0, branchAlive: branchAliveStub(['phantom/fix-typeerror-abc12']) });
  // `seen` includes the crash being handled right now, which is the count a
  // user means by "third time today".
  assert.equal(r.seen, 4, 'three logged crashes plus the one being handled');
  assert.ok(Date.parse(r.firstAt) < Date.parse(r.lastAt), 'first and last are distinct and ordered');
  assert.equal(new Date(r.firstAt).toISOString(), new Date(T0 - 90 * 60000).toISOString());
});

test('crashes outside the window do not count', () => {
  const root = tmp();
  const ctx = ctxFor();
  record(root, ctx, 'fixed', 'phantom/fix-typeerror-abc12', (WINDOW_MS / 60000) + 60);
  const r = lookupPrior(root, ctx, { now: T0, branchAlive: branchAliveStub(['phantom/fix-typeerror-abc12']) });
  assert.equal(r.verdict, 'fresh', 'yesterday is not evidence about today');
});

test('a weak slug never suppresses, and says so', () => {
  // Slug equality WILL sometimes be wrong. BugSnag shows the grouping reason on
  // every error view for exactly this reason: a generic slug groups unrelated
  // crashes, and silently declining to recover one of them would be the worst
  // possible outcome.
  const root = tmp();
  // "Weak" means the slug carries no diagnostic content -- slugify's fallbacks
  // when there is no error line: `crash`, `exit-1`, `signal-sigsegv`. Two
  // different bugs that both make `npm test` exit 1 land in one bucket.
  const weak = ctxFor('exit-1', { errorLine: null });
  record(root, weak, 'fixed', 'phantom/fix-exit-1-abc12', 5);

  const r = lookupPrior(root, weak, { now: T0, branchAlive: branchAliveStub(['phantom/fix-exit-1-abc12']) });
  assert.equal(r.verdict, 'fresh', 'a generic slug is not evidence of the same bug');
  assert.equal(r.grouping.weak, true);
  assert.match(r.reason, /\S/);
});

test('the caller is told WHY two crashes were grouped', () => {
  const root = tmp();
  const ctx = ctxFor();
  record(root, ctx, 'fixed', 'phantom/fix-typeerror-abc12', 5);
  const r = lookupPrior(root, ctx, { now: T0, branchAlive: branchAliveStub(['phantom/fix-typeerror-abc12']) });
  assert.equal(r.grouping.by, 'slug');
  assert.equal(r.grouping.slug, ctx.slug);
  assert.match(r.grouping.note, /\S/, 'a human-readable grouping reason');
});

test('a different error in the same repo is unrelated', () => {
  const root = tmp();
  record(root, ctxFor('typeerror-cannot-read-properties'), 'fixed', 'phantom/fix-typeerror-abc12', 5);
  const other = lookupPrior(root, ctxFor('rangeerror-out-of-cheese'), {
    now: T0, branchAlive: branchAliveStub(['phantom/fix-typeerror-abc12']),
  });
  assert.equal(other.verdict, 'fresh');
  assert.equal(other.seen, 1);
});

test('a missing, empty or corrupt log degrades to fresh instead of throwing', () => {
  // This runs inside the crash handler. Throwing here would turn a recoverable
  // crash into two failures, so every surprise has to mean "do what phantom
  // did before this module existed".
  const ctx = ctxFor();
  assert.equal(lookupPrior(tmp(), ctx, { now: T0 }).verdict, 'fresh', 'no log at all');

  const empty = tmp();
  fs.mkdirSync(path.join(empty, '.phantom'), { recursive: true });
  fs.writeFileSync(path.join(empty, '.phantom', 'events.jsonl'), '');
  assert.equal(lookupPrior(empty, ctx, { now: T0 }).verdict, 'fresh', 'empty log');

  const junk = tmp();
  fs.mkdirSync(path.join(junk, '.phantom'), { recursive: true });
  fs.writeFileSync(path.join(junk, '.phantom', 'events.jsonl'), 'not json\n{"half":\n');
  assert.equal(lookupPrior(junk, ctx, { now: T0 }).verdict, 'fresh', 'corrupt log');

  // And a context missing the fields it would normally read.
  assert.equal(lookupPrior(tmp(), {}, { now: T0 }).verdict, 'fresh', 'empty context');
  assert.equal(lookupPrior(tmp(), null, { now: T0 }).verdict, 'fresh', 'no context at all');
});

test('a branch check that throws does not take the crash handler down with it', () => {
  const root = tmp();
  const ctx = ctxFor();
  record(root, ctx, 'fixed', 'phantom/fix-typeerror-abc12', 5);
  const r = lookupPrior(root, ctx, {
    now: T0,
    branchAlive: () => { throw new Error('git exploded'); },
  });
  assert.equal(r.verdict, 'fresh', 'an unanswerable branch question means recover, not crash');
});
