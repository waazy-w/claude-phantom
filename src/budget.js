'use strict';

const { sumTokens, cachedTokens, formatTokens } = require('./report');

/**
 * A spend ceiling for one recovery.
 *
 * `maxIterations` and `maxMinutes` bound how many times phantom asks and how
 * long it waits -- neither bounds what it spends. One iteration on a large repo
 * re-reads far more than three iterations on a small one, so a user who wants
 * "never spend more than a dollar on one crash" had no way to say it. This
 * module is that ceiling: it counts what the sessions actually consumed and
 * decides, before each additional attempt, whether the next one still fits.
 *
 * Everything here is an ESTIMATE and the API says so in every direction.
 * Phantom cannot see the user's bill: the same recovery costs API-rate dollars
 * on one account and nothing extra on a Max subscription, and Bedrock/Vertex
 * charge their own rates. What phantom does know exactly is the token count --
 * so the tokens are facts, the dollars are arithmetic over a published price
 * list, and no message is allowed to blur the two.
 *
 * Pure: no I/O, no clock, no process.exit. Every input arrives as an argument.
 */

/**
 * USD per million tokens, Anthropic first-party API list rates.
 *
 * ---- UPDATE ME ----
 * Last checked 2026-06-24 against https://claude.com/pricing. Rates change and
 * models are added; this table is the only place that needs editing when they
 * do. Keys are model ids as Claude Code reports them, minus any date suffix
 * (see `normalizeModel`). Only `input` and `output` are listed because the two
 * cache rates have been a fixed multiple of the input rate across the whole
 * lineup -- a row may override them if that ever stops being true.
 * -------------------
 */
const PRICES = Object.freeze({
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
});

/**
 * Writing to the cache costs 1.25x the input rate; reading from it costs 0.1x.
 * The read discount is why a recovery's token total is not its cost: ~97% of a
 * resumed session's input is cache reads, so pricing the total at the input
 * rate would overstate the bill by roughly an order of magnitude.
 *
 * Both assume the default 5-minute cache TTL, which is what phantom's headless
 * sessions use. A 1-hour TTL writes at 2x and would make this an underestimate.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * `--model sonnet` is as common as a full id, and the alias points at whichever
 * model Claude Code currently maps it to -- so an alias is priced at today's
 * member of that family and may drift when Anthropic re-points it.
 */
const ALIASES = Object.freeze({
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
  default: 'claude-sonnet-5',
});

/**
 * What an unrecognised model is priced as.
 *
 * `model` defaults to null -- Claude Code's own choice -- so an unknown or
 * unnamed model is the common case, not an edge case, and the fallback has to
 * be defensible rather than convenient. It prices as the most expensive model
 * Claude Code routinely runs: a ceiling that guesses low stops too late and
 * lets the run pass the limit the user set, which is the one failure this
 * module exists to prevent. Guessing high stops early, and says why.
 */
const FALLBACK_MODEL = 'claude-opus-5';

/** Attached to every dollar figure phantom prints, so none of them can read as a bill. */
const ESTIMATE_CAVEAT = 'an estimate from published API rates, not your actual bill';

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const field = (usage, name) => (usage && Number.isFinite(usage[name]) ? usage[name] : 0);

/**
 * Reduce a model id to a price-table key.
 *
 * Claude Code reports whatever the platform gave it: a bare id, a dated
 * snapshot (`claude-sonnet-4-6-20251114`), a Vertex `@`-version, or a Bedrock
 * id (`us.anthropic.claude-opus-5-v1:0`). All of them are the same model at the
 * same first-party rate, so all of them have to land on the same row.
 */
function normalizeModel(model) {
  let id = String(model === null || model === undefined ? '' : model).trim().toLowerCase();
  if (!id) return '';
  id = id.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '');
  // Only the Bedrock revision suffix, which always carries the colon. A bare
  // trailing number is part of the name -- stripping it would turn
  // claude-opus-5 into claude-opus and price every Opus off the alias table.
  id = id.replace(/-v\d+:\d+$/, '');
  id = id.replace(/[-@]\d{8}$/, '');
  return id;
}

/**
 * Rates for a model id, and how confident we are in them.
 *
 * @param {string|null|undefined} model
 * @returns {{ id: string, pricedAs: string, match: 'exact'|'alias'|'family'|'fallback',
 *             exact: boolean, input: number, output: number, cacheWrite: number, cacheRead: number }}
 */
function priceFor(model) {
  const id = normalizeModel(model);
  let key = null;
  let match = 'fallback';
  if (id && PRICES[id]) {
    key = id;
    match = 'exact';
  } else if (id && ALIASES[id]) {
    key = ALIASES[id];
    match = 'alias';
  } else if (id) {
    // A dated or suffixed variant of a listed model ("claude-opus-5-thinking").
    // Longest first, so claude-opus-4-8 wins over a shorter shared prefix.
    const prefix = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => id.startsWith(k));
    if (prefix) {
      key = prefix;
      match = 'exact';
    } else {
      // An unlisted member of a known family -- a model released after this
      // table was last updated. Its family's current rate is a far better
      // estimate than the blanket fallback, but it is still a guess.
      const family = ['opus', 'sonnet', 'haiku', 'fable'].find((f) => id.includes(f));
      if (family) {
        key = ALIASES[family];
        match = 'family';
      }
    }
  }
  if (!key) key = FALLBACK_MODEL;
  const rates = PRICES[key];
  return {
    id: id || null,
    pricedAs: key,
    match,
    exact: match === 'exact' || match === 'alias',
    input: rates.input,
    output: rates.output,
    cacheWrite: Number.isFinite(rates.cacheWrite) ? rates.cacheWrite : round6(rates.input * CACHE_WRITE_MULTIPLIER),
    cacheRead: Number.isFinite(rates.cacheRead) ? rates.cacheRead : round6(rates.input * CACHE_READ_MULTIPLIER),
  };
}

/**
 * Price one session's usage. The four token kinds are billed at four different
 * rates, so they are counted separately -- collapsing them into a total and
 * multiplying by the input rate is wrong by ~10x on a cache-heavy session.
 *
 * @param {object} [usage] the `usage` object from a Claude Code result JSON
 * @param {string|null} [model]
 * @returns {{ costUsd: number, tokens: number, cachedTokens: number, input: number, output: number,
 *             cacheWrite: number, cacheRead: number, price: ReturnType<typeof priceFor>, estimate: true }}
 */
function estimateCostUsd(usage, model) {
  const price = priceFor(model);
  const input = field(usage, 'input_tokens');
  const output = field(usage, 'output_tokens');
  const cacheWrite = field(usage, 'cache_creation_input_tokens');
  const cacheRead = cachedTokens(usage);
  const costUsd = round6(
    (input * price.input + output * price.output + cacheWrite * price.cacheWrite + cacheRead * price.cacheRead) / 1e6,
  );
  return { costUsd, tokens: sumTokens(usage), cachedTokens: cacheRead, input, output, cacheWrite, cacheRead, price, estimate: true };
}

/** A dollar figure that cannot be mistaken for an exact one. */
function formatCostUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return 'n/a';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '~$' + usd.toFixed(2);
}

/** A limit the user typed. Exact, so no tilde. */
const limitUsd = (usd) => '$' + Number(usd).toFixed(2);

class Budget {
  /**
   * @param {{ maxTokens?: number|null, maxCostUsd?: number|null, model?: string|null }} [opts]
   */
  constructor(opts = {}) {
    // Anything that is not a positive finite number means "no ceiling". config.js
    // validates these before they get here; if something invalid slips through,
    // no ceiling is the safe reading -- a ceiling of 0 or NaN would stop every
    // recovery before its first attempt, which is a worse failure than not
    // capping at all.
    this.maxTokens = num(opts.maxTokens);
    this.maxCostUsd = num(opts.maxCostUsd);
    this.model = opts.model || null;
    this.attempts = [];
  }

  /**
   * Record one finished Claude session.
   *
   * Attempts with no usage at all (a session that died before emitting JSON)
   * are still recorded, at zero, so `attempts` matches phantom's iteration
   * count and a post-mortem cannot silently drop one.
   *
   * @param {object} [usage] `claudeResult.usage`
   * @param {string|null} [model] the model that ran this attempt, if known
   * @returns {ReturnType<typeof estimateCostUsd>} what this attempt alone cost
   */
  record(usage, model) {
    const priced = estimateCostUsd(usage, model === undefined || model === null ? this.model : model);
    this.attempts.push(priced);
    return priced;
  }

  /**
   * Everything spent so far.
   * @returns {{ attempts: number, tokens: number, cachedTokens: number, newTokens: number,
   *             input: number, output: number, cacheWrite: number, cacheRead: number,
   *             costUsd: number, estimate: true, models: string[], exact: boolean }}
   */
  spent() {
    const total = { attempts: this.attempts.length, tokens: 0, cachedTokens: 0, newTokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 };
    const models = [];
    let exact = true;
    for (const a of this.attempts) {
      total.tokens += a.tokens;
      total.cachedTokens += a.cachedTokens;
      total.input += a.input;
      total.output += a.output;
      total.cacheWrite += a.cacheWrite;
      total.cacheRead += a.cacheRead;
      total.costUsd += a.costUsd;
      if (!models.includes(a.price.pricedAs)) models.push(a.price.pricedAs);
      if (!a.price.exact) exact = false;
    }
    total.newTokens = total.tokens - total.cachedTokens;
    total.costUsd = round6(total.costUsd);
    total.models = models;
    // False as soon as any single attempt was priced by guess: a total is only
    // as trustworthy as its least certain part.
    total.exact = exact && models.length > 0;
    total.estimate = true;
    return total;
  }

  /**
   * What the next attempt should be assumed to cost when the caller does not say.
   *
   * The largest attempt so far, not the average and not the last: a resumed
   * session re-reads everything the previous one read plus the new test output,
   * so attempts grow. Projecting from the cheapest one would let the ceiling be
   * crossed by the very attempt it was checked against.
   */
  _projectNext() {
    let tokens = 0;
    let costUsd = 0;
    for (const a of this.attempts) {
      if (a.tokens > tokens) tokens = a.tokens;
      if (a.costUsd > costUsd) costUsd = a.costUsd;
    }
    return { tokens, costUsd };
  }

  /**
   * @param {{ tokens?: number, costUsd?: number, usage?: object, model?: string|null }} [estimate]
   */
  _estimateOf(estimate) {
    if (!estimate || typeof estimate !== 'object') return this._projectNext();
    if (estimate.usage) {
      const priced = estimateCostUsd(estimate.usage, estimate.model === undefined ? this.model : estimate.model);
      return { tokens: priced.tokens, costUsd: priced.costUsd };
    }
    const has = Number.isFinite(estimate.tokens) || Number.isFinite(estimate.costUsd);
    if (!has) return this._projectNext();
    return {
      tokens: Number.isFinite(estimate.tokens) ? estimate.tokens : 0,
      costUsd: Number.isFinite(estimate.costUsd) ? estimate.costUsd : 0,
    };
  }

  /**
   * @typedef {object} BudgetVerdict
   * @property {boolean} affordable
   * @property {boolean} stop always `!affordable`, so a caller can read it either way round
   * @property {string} reason one sentence, safe to print verbatim
   * @property {{ kind: 'tokens'|'costUsd', max: number }|null} limit the ceiling that tripped
   * @property {{ tokens: number, costUsd: number }} spent
   * @property {{ tokens: number, costUsd: number }} projected spent + the estimated next attempt
   */

  /** @returns {BudgetVerdict} */
  _check(next) {
    const s = this.spent();
    const spent = { tokens: s.tokens, costUsd: s.costUsd };
    const projected = { tokens: s.tokens + next.tokens, costUsd: round6(s.costUsd + next.costUsd) };
    const ok = (reason, limit = null) => ({ affordable: true, stop: false, reason, limit, spent, projected });
    const no = (reason, limit) => ({ affordable: false, stop: true, reason, limit, spent, projected });
    if (!this.maxTokens && !this.maxCostUsd) return ok('no spend ceiling configured');

    // Tokens first: they are a fact, so a token verdict needs no caveat and is
    // the one a user can check against their own dashboard.
    if (this.maxTokens) {
      if (s.tokens >= this.maxTokens) {
        return no('token ceiling reached: ' + formatTokens(s.tokens) + ' of the ' + formatTokens(this.maxTokens) + ' allowed', { kind: 'tokens', max: this.maxTokens });
      }
      if (projected.tokens > this.maxTokens) {
        return no('the next attempt (est. ' + formatTokens(next.tokens) + ') would pass the ' + formatTokens(this.maxTokens) + ' ceiling; ' + formatTokens(s.tokens) + ' spent', { kind: 'tokens', max: this.maxTokens });
      }
    }
    if (this.maxCostUsd) {
      const caveat = ' (' + this._pricingNote() + ')';
      if (s.costUsd >= this.maxCostUsd) {
        return no('spend ceiling reached: ' + formatCostUsd(s.costUsd) + ' of the ' + limitUsd(this.maxCostUsd) + ' allowed' + caveat, { kind: 'costUsd', max: this.maxCostUsd });
      }
      if (projected.costUsd > this.maxCostUsd) {
        return no('the next attempt (est. ' + formatCostUsd(next.costUsd) + ') would pass the ' + limitUsd(this.maxCostUsd) + ' ceiling; ' + formatCostUsd(s.costUsd) + ' spent' + caveat, { kind: 'costUsd', max: this.maxCostUsd });
      }
      return ok(formatCostUsd(s.costUsd) + ' of the ' + limitUsd(this.maxCostUsd) + ' ceiling spent; the next attempt is estimated at ' + formatCostUsd(next.costUsd), { kind: 'costUsd', max: this.maxCostUsd });
    }
    return ok(formatTokens(s.tokens) + ' of the ' + formatTokens(this.maxTokens) + ' ceiling spent; the next attempt is estimated at ' + formatTokens(next.tokens), { kind: 'tokens', max: this.maxTokens });
  }

  /**
   * Can phantom afford one more attempt?
   *
   * @param {{ tokens?: number, costUsd?: number, usage?: object, model?: string|null }} [estimate]
   *   what the next attempt is expected to consume. Omit it to project from the
   *   most expensive attempt so far.
   * @returns {BudgetVerdict}
   */
  canAfford(estimate) {
    return this._check(this._estimateOf(estimate));
  }

  /**
   * Has a ceiling already been reached, regardless of what comes next?
   * @returns {BudgetVerdict}
   */
  shouldStop() {
    return this._check({ tokens: 0, costUsd: 0 });
  }

  /** How the dollar figure was arrived at, named so the reader can judge it. */
  _pricingNote() {
    const s = this.spent();
    if (!s.models.length) return ESTIMATE_CAVEAT;
    const unknown = this.attempts.some((a) => a.price.match === 'fallback');
    const family = !unknown && this.attempts.some((a) => a.price.match === 'family');
    if (unknown) return 'model unknown, priced as ' + FALLBACK_MODEL + ' — ' + ESTIMATE_CAVEAT;
    if (family) return 'priced as ' + s.models.join(' + ') + ' — ' + ESTIMATE_CAVEAT;
    return s.models.join(' + ') + ' API rates — ' + ESTIMATE_CAVEAT;
  }

  /**
   * One line for the banner and the post-mortem. Never states a bill: the
   * dollar figure carries a tilde, the word "est.", and the rates it came from.
   * @returns {string}
   */
  describe() {
    const s = this.spent();
    if (!s.attempts) return 'no recovery spend recorded';
    const money = this.maxCostUsd
      ? formatCostUsd(s.costUsd) + ' of ' + limitUsd(this.maxCostUsd) + ' est.'
      : formatCostUsd(s.costUsd) + ' est.';
    const tokens = this.maxTokens
      ? formatTokens(s.tokens, s.cachedTokens) + ' of ' + formatTokens(this.maxTokens)
      : formatTokens(s.tokens, s.cachedTokens);
    return money + ' · ' + tokens + ' · ' + this._pricingNote();
  }
}

/** @param {{ maxTokens?: number|null, maxCostUsd?: number|null, model?: string|null }} [opts] */
const createBudget = (opts) => new Budget(opts);

module.exports = {
  Budget, createBudget, priceFor, normalizeModel, estimateCostUsd, formatCostUsd,
  PRICES, ALIASES, FALLBACK_MODEL, ESTIMATE_CAVEAT, CACHE_WRITE_MULTIPLIER, CACHE_READ_MULTIPLIER,
};
