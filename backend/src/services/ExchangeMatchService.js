'use strict';

const ExchangeMatch = require('../models/ExchangeMatch');
const ExchangeFiatMatch = require('../models/ExchangeFiatMatch');
const logger = require('../config/logger');
const { ZERO_ADDRESS } = require('../utils/ethActivityVocabulary');

// eth_activity.review_reason is VARCHAR(200). Deliberately NOT the activity
// vocabulary's REVIEW_REASONS: this is the matcher's own reason, and the two
// maps answer different questions.
const REVIEW_REASONS = {
  unmatched_exchange: 'No exchange record explains this transfer yet -- import or sync that account',
  suggested_exchange: 'Possible exchange pairing needs confirmation -- review the amount, fee, address and timing evidence',
};
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;

// Strongest evidence first. Ordering is deterministic, but v3 never uses time
// or ids to choose between plausible alternatives: ambiguity produces review
// suggestions. Manual outranks hash because it is the user overruling us.
const METHOD_RANK = { manual: 0, tx_hash: 1, address_amount: 2, amount_window: 3 };

const EVIDENCE_FIELDS = [
  'rule_version', 'comparison_kind', 'comparison_left_amount', 'comparison_right_amount',
  'fee_amount_applied', 'amount_delta', 'amount_tolerance', 'magnitude_ratio',
  'address_match', 'time_delta_seconds',
];

const DECIMAL_SCALE = 10n ** 18n;
const EXACT_AMOUNT_TOLERANCE_SCALED = 0n;

// SQL is the primary matcher, but keep the same policy at the selection
// boundary so a stale/buggy candidate producer cannot reintroduce a material
// false positive. The fixed-point conversion avoids JavaScript float rounding.
function scaledDecimal(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = text.match(/^(-?)(\d+)(?:\.(\d{1,18}))?$/);
  if (!match) return null;
  const fraction = (match[3] || '').padEnd(18, '0');
  const scaled = BigInt(match[2]) * DECIMAL_SCALE + BigInt(fraction || '0');
  return match[1] ? -scaled : scaled;
}

function amountEvidencePasses(candidate) {
  if (candidate.comparison_kind !== 'amount') return true;
  const leftValue = scaledDecimal(candidate.comparison_left_amount);
  const rightValue = scaledDecimal(candidate.comparison_right_amount);
  if (leftValue === null || rightValue === null) return false;
  const left = leftValue < 0n ? -leftValue : leftValue;
  const right = rightValue < 0n ? -rightValue : rightValue;
  const parsedFee = scaledDecimal(candidate.fee_amount_applied) ?? 0n;
  const fee = parsedFee < 0n ? -parsedFee : parsedFee;
  const rawDelta = left > right ? left - right : right - left;
  // Some providers store the transferred quantity gross and expose the fee
  // separately; others store the net quantity and still expose that fee. Both
  // exact representations are admissible. A PARTIAL fee difference is not:
  // max(rawDelta - fee, 0) made every difference smaller than the fee look
  // exact. The residual is therefore the smaller of "no fee applied" and
  // "the documented fee applied in full".
  const feeAdjustedDelta = rawDelta > fee ? rawDelta - fee : fee - rawDelta;
  const amountDelta = rawDelta < feeAdjustedDelta ? rawDelta : feeAdjustedDelta;
  // v3 deliberately has no tolerance band. Import and on-chain quantities are
  // exact NUMERIC values, so after a source-backed same-asset fee is accounted
  // for, any residual means the amounts are not equal.
  return amountDelta <= EXACT_AMOUNT_TOLERANCE_SCALED;
}

function evidenceFor(candidate, fallbackKind = null) {
  return Object.fromEntries(EVIDENCE_FIELDS.map((field) => [
    field,
    candidate[field] ?? (field === 'rule_version' ? 'v3' : field === 'comparison_kind' ? fallbackKind : null),
  ]));
}

const onChainVerdictKey = (row) =>
  `oc:${row.exchange_record_id}:${row.wallet_id}:${row.chain_id}:${row.tx_hash}`;
const pairVerdictKey = (row) => `pr:${row.exchange_record_id}:${row.counter_record_id}`;

// An on-chain candidate is considered before an exchange-to-exchange one. This
// is a KEY, not a side effect of the other keys: without it a pair of equal
// rank (or a merely closer one) takes the record away from the real on-chain
// leg, which is the one thing the shape rule exists to prevent.
const shapeRank = (row) => (row.counter_record_id ? 1 : 0);
const isManual = (row) => row.match_method === 'manual';

// Total order, so two runs over the same data produce byte-identical matches.
// Every key is either an id or an integer count of seconds -- nothing here can
// depend on row order out of Postgres, which has none.
//
// Precedence, strongest first:
//   1. manual -- the user overruling us, whatever shape their answer took.
//   2. shape  -- an on-chain leg ALWAYS beats an exchange-pair claim on the
//      same record: "no tracked wallet in between" is exactly what makes a pair
//      a pair, so a record with a demonstrated on-chain leg is not one half of
//      a venue-to-venue transfer. This costs the hash rule nothing, because the
//      two can never collide: a pair only reaches match_method 'tx_hash' when
//      BOTH its records carry a hash, and a record carrying a hash produces no
//      on-chain candidate below tx_hash rank at all (the fallback arm requires
//      tx_hash IS NULL). So the only pair a fallback on-chain candidate can
//      outrank is itself a fallback.
//   3. method rank -- evidence strength, tx_hash before the guesses.
//   4. time delta, then ids, purely to make the order total.
function compareCandidates(a, b) {
  const manual = (isManual(a) ? 0 : 1) - (isManual(b) ? 0 : 1);
  if (manual !== 0) return manual;
  const shape = shapeRank(a) - shapeRank(b);
  if (shape !== 0) return shape;
  const rank = (METHOD_RANK[a.match_method] ?? 9) - (METHOD_RANK[b.match_method] ?? 9);
  if (rank !== 0) return rank;
  const delta = Number(a.time_delta_seconds ?? a.time_delta ?? 0)
    - Number(b.time_delta_seconds ?? b.time_delta ?? 0);
  if (delta !== 0) return delta;
  const record = Number(a.exchange_record_id) - Number(b.exchange_record_id);
  if (record !== 0) return record;
  const activity = Number(a.activity_id ?? 0) - Number(b.activity_id ?? 0);
  if (activity !== 0) return activity;
  return Number(a.counter_record_id ?? 0) - Number(b.counter_record_id ?? 0);
}

/**
 * Candidates in, matches out. Pure, deterministic, and the only place that
 * decides anything -- which is what makes every rule below testable without a
 * database.
 *
 * One movement is counted ONCE. Manual confirmations and unique transaction
 * hashes are identity. Address + strict fee-adjusted amount and amount + time
 * alone are suggestions and never fold rows. If more than one otherwise-
 * eligible candidate claims the same
 * side, every alternative stays a suggestion instead of a greedy winner being
 * invented from row order or a few seconds of timestamp proximity.
 */
function selectMatches({ onChain = [], pairs = [], verdicts = [] } = {}) {
  const rejected = new Set();
  const confirmed = [];

  for (const verdict of verdicts) {
    const isPair = verdict.counter_record_id !== null && verdict.counter_record_id !== undefined;
    const key = isPair ? pairVerdictKey(verdict) : onChainVerdictKey(verdict);
    if (verdict.verdict === 'rejected') {
      rejected.add(key);
      continue;
    }
    // A confirmation of a transaction that is not currently in eth_activity
    // resolves to no id at all. It stays stored and inert rather than being
    // dropped: the row comes back when the wallet re-syncs.
    if (!isPair && !verdict.activity_id) continue;
    confirmed.push({
      exchange_record_id: verdict.exchange_record_id,
      activity_id: isPair ? null : verdict.activity_id,
      counter_record_id: isPair ? verdict.counter_record_id : null,
      wallet_id: verdict.wallet_id ?? null,
      chain_id: verdict.chain_id ?? null,
      tx_hash: verdict.tx_hash ?? null,
      match_method: 'manual',
      confidence: 'high',
      time_delta: 0,
      rule_version: 'v3',
      comparison_kind: 'manual',
    });
  }

  const candidates = [
    ...confirmed,
    ...onChain.map((row) => ({ ...row, counter_record_id: null })),
    ...pairs.map((row) => ({ ...row, activity_id: null })),
  ].filter((row) => {
    const key = row.counter_record_id ? pairVerdictKey(row) : onChainVerdictKey(row);
    if (rejected.has(key) || !amountEvidencePasses(row)) return false;
    if (row.match_method === 'tx_hash' && row.direction_compatible !== true) return false;
    return true;
  });

  candidates.sort(compareCandidates);

  const claimedRecords = new Set();
  const claimedActivities = new Set();
  const rows = [];
  const suggestions = [];
  const learn = new Map();

  const sideKeys = (candidate) => candidate.counter_record_id
    ? [`record:${Number(candidate.exchange_record_id)}`, `record:${Number(candidate.counter_record_id)}`]
    : [`record:${Number(candidate.exchange_record_id)}`, `activity:${Number(candidate.activity_id)}`];

  const isClaimed = (candidate) => sideKeys(candidate).some((key) => {
    const [kind, id] = key.split(':');
    return kind === 'record' ? claimedRecords.has(Number(id)) : claimedActivities.has(Number(id));
  });

  const claim = (candidate) => {
    const recordId = Number(candidate.exchange_record_id);
    if (candidate.counter_record_id) {
      const counterId = Number(candidate.counter_record_id);
      if (claimedRecords.has(recordId) || claimedRecords.has(counterId) || counterId === recordId) return false;
      claimedRecords.add(recordId);
      claimedRecords.add(counterId);
      rows.push({
        exchange_record_id: recordId,
        activity_id: null,
        counter_record_id: counterId,
        match_method: candidate.match_method,
        confidence: candidate.confidence,
        wallet_id: null,
        chain_id: null,
        tx_hash: null,
        ...evidenceFor(candidate, candidate.match_method === 'tx_hash' ? 'hash' : 'amount'),
      });
      return true;
    }

    const activityId = Number(candidate.activity_id);
    if (!activityId || claimedRecords.has(recordId) || claimedActivities.has(activityId)) return false;
    claimedRecords.add(recordId);
    claimedActivities.add(activityId);
    rows.push({
      exchange_record_id: recordId,
      activity_id: activityId,
      counter_record_id: null,
      match_method: candidate.match_method,
      confidence: candidate.confidence,
      wallet_id: candidate.wallet_id ?? null,
      chain_id: candidate.chain_id ?? null,
      tx_hash: candidate.tx_hash ?? null,
      ...evidenceFor(candidate, candidate.match_method === 'tx_hash' ? 'hash' : 'amount'),
    });

    // The learning loop, restricted to hash matches. A hash match is the
    // exchange telling us which transaction it made, so its counterparty IS the
    // venue -- there is nothing to infer. A fallback match is asset, amount and
    // a time window, and turning that into an 'exchange' label would let a
    // coincidence rewrite real spending as an internal transfer, permanently
    // and everywhere. A user's own confirmation is deliberately not enough
    // either: they answered "these two rows are the same money", not "label
    // this address for every future transfer".
    //
    // Restricted further to a transaction with exactly ONE net leg. The v3
    // hash arm already requires that leg to establish compatible direction;
    // keeping the guard here makes the learning boundary explicit too. On a
    // multi-leg row counterparty_address can be a ROUTER CONTRACT, and labelling
    // it 'exchange' would delete every future interaction with that router from
    // cash flow, globally and permanently.
    if (candidate.match_method === 'tx_hash' && candidate.single_net_leg) {
      const address = String(candidate.counterparty_address || '').toLowerCase();
      if (HEX_ADDRESS.test(address) && address !== ZERO_ADDRESS && !learn.has(address)) {
        learn.set(address, candidate.exchange_account_name || 'Exchange');
      }
    }
    return true;
  };

  const suggest = (candidate, suggestionReason) => {
    if (isClaimed(candidate)) return;
    suggestions.push({
      exchange_record_id: Number(candidate.exchange_record_id),
      activity_id: candidate.counter_record_id ? null : Number(candidate.activity_id),
      counter_record_id: candidate.counter_record_id ? Number(candidate.counter_record_id) : null,
      wallet_id: candidate.counter_record_id ? null : (candidate.wallet_id ?? null),
      chain_id: candidate.counter_record_id ? null : (candidate.chain_id ?? null),
      tx_hash: candidate.counter_record_id ? null : (candidate.tx_hash ?? null),
      match_method: candidate.match_method,
      confidence: candidate.confidence,
      suggestion_reason: suggestionReason,
      ...evidenceFor(candidate, candidate.match_method === 'tx_hash' ? 'hash' : 'amount'),
    });
  };

  // Explicit answers always win. Conflict checks at verdict write time prevent
  // two confirmations from claiming the same record.
  for (const candidate of candidates.filter(isManual)) claim(candidate);

  // Hashes establish identity, but a chain-ambiguous replay or malformed feed
  // can still yield more than one candidate. Do not pick one in that case.
  const hashes = candidates.filter((candidate) => candidate.match_method === 'tx_hash' && !isClaimed(candidate));
  const hashCounts = new Map();
  hashes.forEach((candidate) => sideKeys(candidate).forEach((key) => hashCounts.set(key, (hashCounts.get(key) || 0) + 1)));
  for (const candidate of hashes) {
    if (sideKeys(candidate).some((key) => hashCounts.get(key) > 1)) suggest(candidate, 'ambiguous');
    else claim(candidate);
  }

  // Address corroboration is much stronger than time alone, but still not
  // identity: deposit addresses can be reused and source timestamps can be
  // coarse. It always waits for confirmation.
  const fallbacks = candidates.filter((candidate) => (
    ['address_amount', 'amount_window'].includes(candidate.match_method) && !isClaimed(candidate)
  ));
  const fallbackCounts = new Map();
  fallbacks.forEach((candidate) => sideKeys(candidate).forEach((key) => (
    fallbackCounts.set(key, (fallbackCounts.get(key) || 0) + 1)
  )));
  for (const candidate of fallbacks) {
    const ambiguous = sideKeys(candidate).some((key) => fallbackCounts.get(key) > 1);
    suggest(candidate, ambiguous
      ? 'ambiguous'
      : candidate.match_method === 'address_amount' ? 'address_amount' : 'amount_time_only');
  }

  suggestions.sort(compareCandidates);
  return { rows, suggestions, learn: [...learn].map(([address, name]) => ({ address, name })) };
}

class ExchangeMatchService {
  /**
   * Re-derive every match this user has, from scratch.
   *
   * Runs at the END of the activity rebuild (EthActivityService), which is what
   * the issue asks for and also the only order that works: eth_activity is
   * delete-then-insert, so a match written before the rebuild is cascaded away
   * by it.
   *
   * Scoped to the USER rather than to the wallet whose rebuild triggered it.
   * Matching is a one-to-one claim over a shared pool of exchange records, so a
   * per-wallet pass would let whichever wallet rebuilt last take a record from
   * the one that rebuilt first -- the answer would depend on iteration order.
   * Re-deriving the whole user is a handful of rows and has no order at all.
   */
  static async rebuildForUser(userId) {
    if (!userId) throw new Error('ExchangeMatchService.rebuildForUser requires a userId');

    const [onChain, pairs, verdicts] = await Promise.all([
      ExchangeMatch.onChainCandidates(userId),
      ExchangeMatch.exchangePairCandidates(userId),
      ExchangeMatch.verdictsForUser(userId),
    ]);

    const { rows, suggestions, learn } = selectMatches({ onChain, pairs, verdicts });
    const replacement = await ExchangeMatch.replaceForUser(userId, rows, suggestions);
    const matches = replacement.inserted;
    // Order matters between these two only in that both are idempotent and
    // mutually exclusive: one needs a match to exist, the other needs one not
    // to. Clearing first keeps a row that just gained a match from being read
    // as unmatched in the same pass.
    const cleared = await ExchangeMatch.clearReviewForMatched(userId);
    const unavailable = await ExchangeMatch.clearReviewForUnavailable(userId);
    const restored = await ExchangeMatch.restoreReviewForAvailable(userId, REVIEW_REASONS.unmatched_exchange);
    let fiat = { matched: 0 };
    try {
      fiat = await ExchangeFiatMatch.rebuildForUser(userId);
    } catch (error) {
      // The fiat link is a derived companion to exchange matching. Keep the
      // core exchange/on-chain pass usable during a rolling deploy where the
      // new migration has not reached every instance yet; the next rebuild
      // retries it after the schema is present.
      logger.warn({ userId, err: error }, 'Exchange fiat matching skipped');
    }
    const flagged = await ExchangeMatch.flagUnmatchedExchangeFlows(
      userId,
      REVIEW_REASONS.unmatched_exchange,
      REVIEW_REASONS.suggested_exchange
    );

    // Labels heal FUTURE classification, exactly as the issue says: nothing
    // here re-runs the ladder. Calling refreshClassificationsForUser from
    // inside a rebuild would re-enter the rebuild that called it, and the next
    // sync (or the next label write) re-derives everything anyway.
    let learned = 0;
    for (const label of learn) {
      try {
        if (await ExchangeMatch.learnExchangeLabel(userId, label.address, label.name)) learned += 1;
      } catch (err) {
        logger.warn({ userId, address: label.address, err }, 'Auto-label from exchange match failed');
      }
    }

    logger.info({ userId, matches, suggestions: replacement.suggested, invalidated: replacement.invalidated, cleared, unavailable, restored, flagged, learned, fiat: fiat.matched }, 'Exchange matches rebuilt');
    return { matches, suggestions: replacement.suggested, invalidated: replacement.invalidated, cleared, unavailable, restored, flagged, learned, fiat: fiat.matched };
  }

  // Same pass, but never fatal. Every caller outside the activity rebuild is
  // finishing some OTHER piece of work -- a CSV import, an API sync, deleting
  // an account -- and none of them should report failure because a derived
  // side table could not be refreshed.
  static async rebuildForUserSafely(userId, context = {}) {
    try {
      return await this.rebuildForUser(userId);
    } catch (err) {
      logger.warn({ userId, ...context, err }, 'Exchange match rebuild failed');
      return null;
    }
  }
}

module.exports = ExchangeMatchService;
module.exports.selectMatches = selectMatches;
module.exports.REVIEW_REASONS = REVIEW_REASONS;
module.exports.METHOD_RANK = METHOD_RANK;
module.exports.amountEvidencePasses = amountEvidencePasses;
