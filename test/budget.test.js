'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Budget, createBudget, priceFor, normalizeModel, estimateCostUsd, formatCostUsd,
  PRICES, FALLBACK_MODEL, CACHE_WRITE_MULTIPLIER, CACHE_READ_MULTIPLIER,
} = require('../src/budget');
const { sumTokens } = require('../src/report');

// One realistic session: a little new input, a patch's worth of output, one
// cache write, and the re-read that dominates every resumed session.
const USAGE = Object.freeze({ input_tokens: 120, output_tokens: 880, cache_creation_input_tokens: 4000, cache_read_input_tokens: 7200 });
// (120*5 + 880*25 + 4000*6.25 + 7200*0.5) / 1e6 at claude-opus-5 rates
const USAGE_OPUS_USD = 0.0512;

test('a model id survives normalization however the platform spells it', () => {
  assert.equal(normalizeModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel('  Claude-Opus-5  '), 'claude-opus-5');
  assert.equal(normalizeModel('claude-sonnet-4-6-20251114'), 'claude-sonnet-4-6', 'dated snapshot');
  assert.equal(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5', 'vertex @-version');
  assert.equal(normalizeModel('us.anthropic.claude-opus-5-v1:0'), 'claude-opus-5', 'bedrock id');
  assert.equal(normalizeModel('anthropic.claude-haiku-4-5'), 'claude-haiku-4-5');
  // The version digit is part of the name. Stripping a bare trailing number
  // would leave "claude-opus" and price every Opus off the alias row instead.
  assert.equal(normalizeModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel('claude-sonnet-5'), 'claude-sonnet-5');
  for (const empty of [null, undefined, '', '   ']) assert.equal(normalizeModel(empty), '');
});

test('priceFor resolves ids, aliases, suffixed variants and families', () => {
  assert.equal(priceFor('claude-opus-5').match, 'exact');
  assert.equal(priceFor('claude-opus-5').input, 5);
  assert.equal(priceFor('claude-opus-5').output, 25);
  assert.equal(priceFor('claude-sonnet-4-6-20251114').match, 'exact', 'a dated snapshot is the same model');
  assert.equal(priceFor('claude-sonnet-4-6-20251114').pricedAs, 'claude-sonnet-4-6');
  assert.equal(priceFor('sonnet').match, 'alias', '--model sonnet is as common as a full id');
  assert.equal(priceFor('sonnet').pricedAs, 'claude-sonnet-5');
  assert.equal(priceFor('haiku').input, 1);
  // A model released after the table was last updated: its family's rate beats
  // the blanket fallback, but it is still flagged as a guess.
  const future = priceFor('claude-opus-9');
  assert.equal(future.match, 'family');
  assert.equal(future.exact, false);
  assert.equal(future.pricedAs, 'claude-opus-5');
});

test('cache rates are a fixed multiple of the input rate, per model', () => {
  // Rounded to six places on the way out: 3 * 0.1 is 0.30000000000000004 in
  // binary floating point, and a rate that trails junk digits puts them in
  // every total the ceiling is then compared against.
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  for (const [id, row] of Object.entries(PRICES)) {
    const p = priceFor(id);
    assert.equal(p.cacheWrite, round6(row.input * CACHE_WRITE_MULTIPLIER), id + ' cache write');
    assert.equal(p.cacheRead, round6(row.input * CACHE_READ_MULTIPLIER), id + ' cache read');
    assert.ok(p.cacheRead < p.input, id + ': a cache read must be cheaper than fresh input');
    assert.ok(p.cacheWrite > p.input, id + ': a cache write costs more than fresh input');
  }
});

test('an unknown or unset model is priced as the fallback, and says so', () => {
  // config.model defaults to null (Claude Code picks), so this is the common case.
  for (const unknown of [null, undefined, '', 'gpt-4', 'llama-3', 'some-internal-build']) {
    const p = priceFor(unknown);
    assert.equal(p.match, 'fallback', JSON.stringify(unknown));
    assert.equal(p.exact, false);
    assert.equal(p.pricedAs, FALLBACK_MODEL);
  }
  // The fallback must never be cheaper than a model Claude Code might really
  // have run, or a ceiling checked against it would be passed unnoticed.
  // (Fable/Mythos are excluded: Claude Code does not route to them by default.)
  const routine = Object.entries(PRICES).filter(([id]) => /opus|sonnet|haiku/.test(id));
  const fallback = priceFor(null);
  for (const [id, row] of routine) {
    assert.ok(fallback.input >= row.input, 'fallback input rate must not undercut ' + id);
    assert.ok(fallback.output >= row.output, 'fallback output rate must not undercut ' + id);
  }
});

test('the four kinds of token are priced at four different rates', () => {
  const at = (usage) => estimateCostUsd(usage, 'claude-opus-5').costUsd;
  const M = 1e6;
  assert.equal(at({ input_tokens: M }), 5);
  assert.equal(at({ output_tokens: M }), 25, 'output is 5x input');
  assert.equal(at({ cache_creation_input_tokens: M }), 6.25, 'a cache write is 1.25x input');
  assert.equal(at({ cache_read_input_tokens: M }), 0.5, 'a cache read is a tenth of input');
  // The number this distinction exists for. Almost all of a resumed session's
  // input is cache reads; pricing the total at the input rate overstates the
  // recovery by 10x and would make the ceiling fire on a run that cost cents.
  assert.equal(at({ input_tokens: M }) / at({ cache_read_input_tokens: M }), 10);
  assert.equal(at(USAGE), USAGE_OPUS_USD);
});

test('the same usage costs less on a cheaper model', () => {
  const opus = estimateCostUsd(USAGE, 'claude-opus-5').costUsd;
  const sonnet = estimateCostUsd(USAGE, 'claude-sonnet-5').costUsd;
  const haiku = estimateCostUsd(USAGE, 'haiku').costUsd;
  assert.equal(opus, 0.0512);
  assert.equal(sonnet, 0.03072);
  assert.equal(haiku, 0.01024);
  assert.ok(haiku < sonnet && sonnet < opus);
});

test('estimateCostUsd reuses the report helpers and survives junk usage', () => {
  const priced = estimateCostUsd(USAGE, 'claude-opus-5');
  assert.equal(priced.tokens, sumTokens(USAGE), 'the total must be the same one the post-mortem prints');
  assert.equal(priced.tokens, 12200);
  assert.equal(priced.cachedTokens, 7200);
  assert.equal(priced.estimate, true, 'never presented as a fact');
  for (const junk of [undefined, null, {}, 'nope', 42]) {
    const p = estimateCostUsd(junk, 'claude-opus-5');
    assert.equal(p.costUsd, 0, JSON.stringify(junk));
    assert.equal(p.tokens, 0);
  }
  assert.equal(estimateCostUsd({ input_tokens: 'lots', output_tokens: 1e6 }, 'claude-opus-5').costUsd, 25, 'non-numeric fields ignored');
});

test('record accumulates across attempts and keeps the cache split', () => {
  const b = new Budget({ model: 'claude-opus-5' });
  assert.equal(b.spent().attempts, 0);
  assert.equal(b.spent().costUsd, 0);
  const first = b.record(USAGE);
  assert.equal(first.costUsd, USAGE_OPUS_USD, 'record returns what this attempt alone cost');
  b.record(USAGE);
  const s = b.spent();
  assert.equal(s.attempts, 2);
  assert.equal(s.tokens, 24400);
  assert.equal(s.cachedTokens, 14400);
  assert.equal(s.newTokens, 10000, 'what was actually new');
  assert.equal(s.costUsd, 0.1024);
  assert.deepEqual(s.models, ['claude-opus-5']);
  assert.equal(s.exact, true);
});

test('an attempt that produced no usage is still counted, at zero', () => {
  // A session that dies before emitting JSON (not logged in, killed) must not
  // vanish from the post-mortem's attempt count.
  const b = new Budget({ model: 'claude-opus-5' });
  b.record(undefined);
  b.record(USAGE);
  assert.equal(b.spent().attempts, 2);
  assert.equal(b.spent().costUsd, USAGE_OPUS_USD);
});

test('a per-attempt model overrides the configured one, and one guess taints the total', () => {
  const b = new Budget({ model: 'claude-opus-5' });
  b.record(USAGE);
  b.record(USAGE, 'claude-haiku-4-5');
  const s = b.spent();
  assert.equal(s.costUsd, 0.06144, 'each attempt priced at the model that ran it');
  assert.deepEqual(s.models, ['claude-opus-5', 'claude-haiku-4-5']);
  assert.equal(s.exact, true);

  const guessed = new Budget({ model: 'claude-opus-5' });
  guessed.record(USAGE);
  guessed.record(USAGE, 'who-knows');
  assert.equal(guessed.spent().exact, false, 'a total is only as certain as its least certain part');
});

test('with no ceiling configured every attempt is affordable', () => {
  const b = new Budget();
  b.record(USAGE);
  const v = b.canAfford();
  assert.equal(v.affordable, true);
  assert.equal(v.stop, false);
  assert.equal(v.limit, null);
  assert.match(v.reason, /no spend ceiling configured/);
  assert.equal(b.shouldStop().stop, false);
});

test('a cost ceiling stops the attempt that would pass it, not the one after', () => {
  const b = new Budget({ maxCostUsd: 0.1, model: 'claude-opus-5' });
  // Nothing spent yet: the first attempt is always allowed, or a ceiling would
  // mean phantom never tries at all.
  assert.equal(b.canAfford().affordable, true);
  assert.equal(b.shouldStop().stop, false);

  b.record(USAGE); // ~$0.0512 spent, under the ceiling
  assert.equal(b.shouldStop().stop, false, 'the ceiling is not reached yet');
  const v = b.canAfford(); // a second attempt would land at ~$0.1024
  assert.equal(v.affordable, false);
  assert.equal(v.stop, true);
  assert.deepEqual(v.limit, { kind: 'costUsd', max: 0.1 });
  assert.equal(v.spent.costUsd, 0.0512);
  assert.equal(v.projected.costUsd, 0.1024);
  assert.match(v.reason, /would pass the \$0\.10 ceiling/);
  assert.match(v.reason, /not your actual bill/, 'a refusal must not read as a bill');
});

test('a projection that lands exactly on the ceiling is still affordable', () => {
  const b = new Budget({ maxCostUsd: 0.1024, model: 'claude-opus-5' });
  b.record(USAGE);
  assert.equal(b.canAfford().affordable, true, 'the ceiling is a limit, not a limit minus one cent');
  b.record(USAGE);
  const v = b.shouldStop();
  assert.equal(v.stop, true, 'having reached it, there is nothing left to spend');
  assert.match(v.reason, /spend ceiling reached/);

  // Same boundary on the token side: spending up to the ceiling is allowed,
  // spending past it is not, and reaching it ends the run.
  const t = new Budget({ maxTokens: 24400, model: 'claude-opus-5' });
  t.record(USAGE);
  assert.equal(t.canAfford().affordable, true);
  assert.equal(t.canAfford({ tokens: 12201 }).affordable, false, 'one token past is one token too many');
  t.record(USAGE);
  assert.equal(t.shouldStop().stop, true);
  assert.match(t.shouldStop().reason, /token ceiling reached/);
});

test('the running total stays an exact number of cents', () => {
  // Binary floating point turns 0.000916 + 0.002321 into 0.0032370000000000003.
  // The comparison would survive that; the report and the webhook payload it is
  // serialized into would carry the junk digits into a figure the user reads.
  const b = new Budget({ model: 'claude-opus-5' });
  b.record({ input_tokens: 37, output_tokens: 11, cache_read_input_tokens: 911 });
  b.record({ input_tokens: 53, output_tokens: 7, cache_creation_input_tokens: 301 });
  const total = b.spent().costUsd;
  assert.equal(total, 0.003237);
  assert.equal(String(total), '0.003237');
  // Projections are summed too, so they are rounded on the same terms.
  assert.equal(b.canAfford().projected.costUsd, 0.005558);
});

test('a token ceiling behaves the same way and needs no caveat', () => {
  const b = new Budget({ maxTokens: 20000, model: 'claude-opus-5' });
  b.record(USAGE); // 12200 tokens
  const v = b.canAfford();
  assert.equal(v.affordable, false);
  assert.deepEqual(v.limit, { kind: 'tokens', max: 20000 });
  assert.equal(v.projected.tokens, 24400);
  assert.match(v.reason, /would pass the 20k tokens ceiling/);
  // Tokens are a fact phantom measured, so this verdict claims nothing about money.
  assert.ok(!/\$/.test(v.reason), v.reason);

  const roomy = new Budget({ maxTokens: 30000, model: 'claude-opus-5' });
  roomy.record(USAGE);
  const ok = roomy.canAfford();
  assert.equal(ok.affordable, true);
  assert.match(ok.reason, /12\.2k tokens of the 30k tokens ceiling spent/);
});

test('both ceilings apply at once and the tokens one is reported first', () => {
  const b = new Budget({ maxTokens: 15000, maxCostUsd: 100, model: 'claude-opus-5' });
  b.record(USAGE);
  assert.equal(b.canAfford().limit.kind, 'tokens');
  const money = new Budget({ maxTokens: 1e9, maxCostUsd: 0.06, model: 'claude-opus-5' });
  money.record(USAGE);
  assert.equal(money.canAfford().limit.kind, 'costUsd', 'the cost ceiling still bites when tokens are fine');
});

test('the default projection is the largest attempt so far, not the last', () => {
  // Attempts grow: a resumed session re-reads everything the previous one read
  // plus the new test output. Projecting from a cheap trailing attempt would
  // let the ceiling be crossed by the very attempt it was checked against.
  const b = new Budget({ maxCostUsd: 0.1, model: 'claude-opus-5' });
  b.record({ output_tokens: 3000000 }); // $75 — an outlier
  b.record({ output_tokens: 1000 });    // the last attempt is tiny
  assert.equal(b.canAfford().projected.costUsd, 75 + 0.025 + 75);
});

test('an explicit estimate overrides the projection, in tokens, dollars or usage', () => {
  const b = new Budget({ maxCostUsd: 1, model: 'claude-opus-5' });
  b.record(USAGE);
  assert.equal(b.canAfford({ costUsd: 0.5 }).projected.costUsd, 0.5512);
  assert.equal(b.canAfford({ costUsd: 2 }).affordable, false);
  assert.equal(b.canAfford({ usage: USAGE }).projected.costUsd, 0.1024, 'a usage estimate is priced like a real attempt');
  assert.equal(b.canAfford({ usage: USAGE, model: 'haiku' }).projected.costUsd, 0.06144);
  const t = new Budget({ maxTokens: 20000, model: 'claude-opus-5' });
  t.record(USAGE);
  assert.equal(t.canAfford({ tokens: 100 }).affordable, true);
  assert.equal(t.canAfford({ tokens: 100000 }).affordable, false);
});

test('an invalid ceiling means no ceiling, never a ceiling of zero', () => {
  // A ceiling of 0 or NaN would stop every recovery before its first attempt --
  // a worse failure than not capping at all. config.js validates these; this is
  // the backstop for anything that slips through.
  for (const bad of [0, -1, NaN, Infinity, null, undefined, '2.00', {}]) {
    const b = new Budget({ maxCostUsd: bad, maxTokens: bad });
    b.record(USAGE);
    assert.equal(b.maxCostUsd, null, JSON.stringify(bad));
    assert.equal(b.maxTokens, null, JSON.stringify(bad));
    assert.equal(b.canAfford().affordable, true, JSON.stringify(bad));
  }
});

test('formatCostUsd marks every figure as an estimate', () => {
  assert.equal(formatCostUsd(0.4536), '~$0.45');
  assert.equal(formatCostUsd(12), '~$12.00');
  assert.equal(formatCostUsd(0), '$0.00', 'nothing spent is exact');
  assert.equal(formatCostUsd(0.004), '<$0.01', 'a bound, not a rounded-to-zero figure');
  for (const bad of [null, undefined, NaN, Infinity, -1, '0.5']) assert.equal(formatCostUsd(bad), 'n/a');
});

test('describe is honest about what the dollar figure is', () => {
  const b = new Budget({ maxCostUsd: 2, model: 'claude-opus-5' });
  assert.equal(b.describe(), 'no recovery spend recorded');
  // A real one-iteration recovery: 468.2k tokens, all but 12.2k of it cache reads.
  b.record({ input_tokens: 200, output_tokens: 8000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 456000 });
  const line = b.describe();
  assert.equal(line, '~$0.45 of $2.00 est. · 468.2k tokens (12.2k new · 456k cached) · claude-opus-5 API rates — an estimate from published API rates, not your actual bill');
  assert.match(line, /~\$/, 'the tilde is part of the number');
  assert.match(line, /est\./);
  assert.match(line, /not your actual bill/);
});

test('describe names the fallback when the model is unknown', () => {
  const b = new Budget();
  b.record(USAGE);
  const line = b.describe();
  assert.match(line, /model unknown, priced as claude-opus-5/, 'say so rather than guess silently');
  assert.match(line, /not your actual bill/);
  assert.ok(!line.includes(' of $'), 'no ceiling configured, so none is quoted');
  assert.match(line, /12\.2k tokens \(5k new · 7\.2k cached\)/);
});

test('the module is pure: no shared state, no mutation of its inputs', () => {
  const usage = { input_tokens: 120, output_tokens: 880, cache_creation_input_tokens: 4000, cache_read_input_tokens: 7200 };
  const before = JSON.stringify(usage);
  const a = createBudget({ maxCostUsd: 1, model: 'claude-opus-5' });
  const b = createBudget({ maxCostUsd: 1, model: 'claude-opus-5' });
  a.record(usage);
  assert.equal(JSON.stringify(usage), before, 'the caller keeps its usage object intact');
  assert.equal(b.spent().attempts, 0, 'two budgets share nothing');
  assert.equal(a.spent().attempts, 1);
  assert.ok(createBudget() instanceof Budget);
  // spent() hands out a copy; mutating it must not corrupt the running total.
  const s = a.spent();
  s.costUsd = 999;
  assert.equal(a.spent().costUsd, USAGE_OPUS_USD);
});
