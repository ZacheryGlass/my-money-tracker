'use strict';

// Matching on-chain movements to exchange records (#61): "sent 1.4 ETH to
// Coinbase" and "Coinbase received 1.4 ETH" are one event seen twice.
//
// The decision half -- which candidate wins, what the user's verdict does, when
// an address may be learned -- is a pure function and is exercised directly.
// The stateful half (the rebuild's delete-then-insert, verdict survival, route
// scoping) runs against a fake pg Pool that stands in for the two tables and
// their UNIQUE keys, the same way ethActivity.test.js does.
//
// The candidate SQL itself is pinned by asserting on the statement text: the
// exact residual has to stay NUMERIC, the direction test has to stay in the
// join, and both sides have to stay scoped through their root tables. Those are
// the properties a rewrite could silently drop.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const OWNER_ID = 1;
const WALLET_ID = 1;
const FOREIGN_WALLET_ID = 99;
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VENUE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const TX2 = '0x2222222222222222222222222222222222222222222222222222222222222222';

const KRAKEN_ACCOUNT = 7;
const COINBASE_ACCOUNT = 8;

// --- the fake database -----------------------------------------------------

const db = {
  // What the two candidate queries would return for the current data. Seeded
  // per test in exactly the column shape the SQL projects.
  onChainCandidates: [],
  pairCandidates: [],
  // The real tables.
  matches: [],
  suggestions: [],
  verdicts: new Map(),
  activity: [],
  labels: [],
  records: new Map(),
  events: [],
};
const queries = [];

const verdictKey = (row) => (row.counter_record_id
  ? `pr:${row.exchange_record_id}:${row.counter_record_id}`
  : `oc:${row.exchange_record_id}:${row.wallet_id}:${row.chain_id}:${row.tx_hash}`);

const MATCH_COLUMNS = [
  'exchange_record_id', 'activity_id', 'counter_record_id', 'match_method', 'confidence',
  'rule_version', 'comparison_kind', 'comparison_left_amount', 'comparison_right_amount',
  'fee_amount_applied', 'amount_delta', 'amount_tolerance', 'magnitude_ratio',
  'address_match', 'time_delta_seconds',
];
const SUGGESTION_COLUMNS = [
  'exchange_record_id', 'activity_id', 'counter_record_id', 'wallet_id', 'chain_id', 'tx_hash',
  'match_method', 'confidence', 'suggestion_reason',
  'rule_version', 'comparison_kind', 'comparison_left_amount', 'comparison_right_amount',
  'fee_amount_applied', 'amount_delta', 'amount_tolerance', 'magnitude_ratio',
  'address_match', 'time_delta_seconds',
];

let nextMatchId = 1;

function fakeQuery(text, params = []) {
  const sql = String(text).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });

  // The on-chain candidate query leads with the activity CTE; the
  // exchange-to-exchange one leads with the records CTE.
  if (/^WITH scoped_activity AS/.test(sql)) {
    return { rows: params[0] === OWNER_ID ? db.onChainCandidates : [] };
  }
  if (/^WITH scoped_records AS/.test(sql)) {
    return { rows: params[0] === OWNER_ID ? db.pairCandidates : [] };
  }
  if (/^SELECT v\.id, v\.exchange_record_id, v\.counter_record_id, v\.verdict/.test(sql)) {
    if (params[0] !== OWNER_ID) return { rows: [] };
    return {
      rows: [...db.verdicts.values()].map((row) => ({
        ...row,
        // The LEFT JOIN that resolves the stable key to whatever surrogate id
        // the last rebuild happened to write.
        activity_id: db.activity.find((a) => a.wallet_id === row.wallet_id
          && a.chain_id === row.chain_id && a.tx_hash === row.tx_hash)?.id ?? null,
      })),
    };
  }
  if (/^DELETE FROM exchange_matches m/.test(sql)) {
    const removed = db.matches.length;
    db.matches = [];
    return { rows: [], rowCount: removed };
  }
  if (/^DELETE FROM exchange_match_suggestions s/.test(sql)) {
    const removed = db.suggestions.length;
    db.suggestions = [];
    return { rows: [], rowCount: removed };
  }
  if (/^INSERT INTO exchange_matches/.test(sql)) {
    let inserted = 0;
    for (let i = 0; i < params.length; i += MATCH_COLUMNS.length) {
      const row = { id: nextMatchId++ };
      MATCH_COLUMNS.forEach((column, j) => { row[column] = params[i + j]; });
      // Stands in for the three unique indexes.
      const clash = db.matches.some((existing) => existing.exchange_record_id === row.exchange_record_id
        || (row.activity_id !== null && existing.activity_id === row.activity_id)
        || (row.counter_record_id !== null && existing.counter_record_id === row.counter_record_id));
      if (clash) continue;
      db.matches.push(row);
      inserted += 1;
    }
    return { rows: [], rowCount: inserted };
  }
  if (/^INSERT INTO exchange_match_suggestions/.test(sql)) {
    let inserted = 0;
    for (let i = 0; i < params.length; i += SUGGESTION_COLUMNS.length) {
      const row = { id: db.suggestions.length + 1 };
      SUGGESTION_COLUMNS.forEach((column, j) => { row[column] = params[i + j]; });
      const clash = db.suggestions.some((existing) => verdictKey(existing) === verdictKey(row));
      if (clash) continue;
      db.suggestions.push(row);
      inserted += 1;
    }
    return { rows: [], rowCount: inserted };
  }
  if (/^INSERT INTO exchange_match_events/.test(sql)) {
    const [eventKey, exchangeRecordId, counterRecordId, walletId, chainId, txHash,
      priorMatchMethod, priorConfidence, reason, ruleVersion, comparisonKind,
      comparisonLeftAmount, comparisonRightAmount, feeAmountApplied, amountDelta,
      amountTolerance, magnitudeRatio, addressMatch, timeDeltaSeconds] = params;
    if (!db.events.some((event) => event.event_key === eventKey)) {
      db.events.push({
        event_key: eventKey,
        exchange_record_id: exchangeRecordId,
        counter_record_id: counterRecordId,
        wallet_id: walletId,
        chain_id: chainId,
        tx_hash: txHash,
        prior_match_method: priorMatchMethod,
        prior_confidence: priorConfidence,
        reason,
        rule_version: ruleVersion,
        comparison_kind: comparisonKind,
        comparison_left_amount: comparisonLeftAmount,
        comparison_right_amount: comparisonRightAmount,
        fee_amount_applied: feeAmountApplied,
        amount_delta: amountDelta,
        amount_tolerance: amountTolerance,
        magnitude_ratio: magnitudeRatio,
        address_match: addressMatch,
        time_delta_seconds: timeDeltaSeconds,
      });
    }
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE eth_activity a SET needs_review =/.test(sql)
      && !/^UPDATE eth_activity a SET needs_review = TRUE/.test(sql)) {
    let count = 0;
    for (const row of db.activity) {
      const match = db.matches.find((m) => m.activity_id === row.id);
      if (!match || !['tx_hash', 'manual'].includes(match.match_method)) continue;
      if (row.needs_review === false
          && row.review_reason === null
          && row.confidence === match.confidence) continue;
      row.needs_review = false;
      row.review_reason = null;
      row.confidence = match.confidence;
      count += 1;
    }
    return { rows: [], rowCount: count };
  }
  if (/^UPDATE eth_activity a SET needs_review = TRUE/.test(sql)
      && /exchange_records_unavailable/.test(sql)) {
    const [, reason] = params;
    let count = 0;
    for (const row of db.activity) {
      if (row.review_reason !== 'exchange_records_unavailable') continue;
      row.needs_review = true;
      row.review_reason = reason;
      row.confidence = 'low';
      count += 1;
    }
    return { rows: [], rowCount: count };
  }
  if (/^UPDATE eth_activity a SET needs_review = TRUE/.test(sql)) {
    const [, reason, , suggestionReason] = params;
    // The gate: matching has to be in play at all before "unmatched" means
    // anything, so the user must hold at least one deposit/withdrawal record.
    const inPlay = [...db.records.values()]
      .some((r) => r.record_type === 'deposit' || r.record_type === 'withdrawal');
    let count = 0;
    if (inPlay) {
      for (const row of db.activity) {
        if (!['exchange_deposit', 'exchange_withdrawal'].includes(row.category)) continue;
        if (db.matches.some((m) => m.activity_id === row.id)) continue;
        const hasSuggestion = db.suggestions.some((s) => s.activity_id === row.id);
        const nextReason = hasSuggestion ? (suggestionReason || reason) : reason;
        if (row.needs_review && (!hasSuggestion || (row.review_reason === nextReason && row.confidence === 'low'))) continue;
        row.needs_review = true;
        row.review_reason = nextReason;
        row.confidence = 'low';
        count += 1;
      }
    }
    return { rows: [], rowCount: count };
  }
  if (/^INSERT INTO eth_address_labels/.test(sql)) {
    const [userId, address, name] = params;
    if (db.labels.some((label) => label.address === address
      && (label.user_id === userId || label.user_id === null))) {
      return { rows: [] };
    }
    db.labels.push({ user_id: userId, address, name, source: 'auto-match', kind: 'exchange', confidence: 'low' });
    return { rows: [{ address }] };
  }
  if (/^SELECT er\.id, er\.record_type FROM exchange_records er/.test(sql)) {
    const [userId, ids] = params;
    if (userId !== OWNER_ID) return { rows: [] };
    return {
      rows: ids.filter((id) => db.records.has(id))
        .map((id) => ({ id, record_type: db.records.get(id).record_type })),
    };
  }
  if (/^SELECT v\.id, v\.exchange_record_id, v\.counter_record_id, v\.wallet_id/.test(sql)) {
    // The conflicting-confirmation probe: any OTHER confirmed verdict of this
    // user's that already claims one of these two records.
    const [userId, recordIds, exchangeRecordId, counterRecordId, walletId, chainId, txHash] = params;
    if (userId !== OWNER_ID) return { rows: [] };
    const same = (row) => row.exchange_record_id === exchangeRecordId
      && (row.counter_record_id ?? null) === (counterRecordId ?? null)
      && (row.wallet_id ?? null) === (walletId ?? null)
      && (row.chain_id ?? null) === (chainId ?? null)
      && (row.tx_hash ?? null) === (txHash ?? null);
    const hit = [...db.verdicts.values()].find((row) => row.verdict === 'confirmed'
      && (recordIds.includes(row.exchange_record_id) || recordIds.includes(row.counter_record_id))
      && !same(row));
    return { rows: hit ? [hit] : [] };
  }
  if (/^SELECT 1 FROM eth_activity a JOIN eth_wallets w/.test(sql)) {
    const [walletId, chainId, txHash, userId] = params;
    if (userId !== OWNER_ID) return { rows: [] };
    const found = db.activity.some((row) => row.wallet_id === walletId
      && row.chain_id === chainId && row.tx_hash === txHash);
    return { rows: found ? [{ '?column?': 1 }] : [] };
  }
  if (/^INSERT INTO exchange_match_verdicts/.test(sql)) {
    const [exchangeRecordId, walletId, chainId, txHash, counterRecordId, verdict, note, userId] = params;
    if (userId !== OWNER_ID || !db.records.has(exchangeRecordId)) return { rows: [] };
    // The statement's own wallet gate: a wallet id is only bindable when this
    // user owns it (WALLET_ID here; FOREIGN_WALLET_ID belongs to someone else).
    if (walletId !== null && walletId !== WALLET_ID) return { rows: [] };
    const row = {
      id: db.verdicts.size + 1,
      exchange_record_id: exchangeRecordId,
      wallet_id: walletId,
      chain_id: chainId,
      tx_hash: txHash,
      counter_record_id: counterRecordId,
      verdict,
      note,
    };
    db.verdicts.set(verdictKey(row), row);
    return { rows: [row] };
  }
  if (/^DELETE FROM exchange_match_verdicts v/.test(sql)) {
    const [userId, exchangeRecordId, counterRecordId, walletId, chainId, txHash] = params;
    if (userId !== OWNER_ID) return { rows: [] };
    const key = verdictKey({
      exchange_record_id: exchangeRecordId,
      counter_record_id: counterRecordId,
      wallet_id: walletId,
      chain_id: chainId,
      tx_hash: txHash,
    });
    const row = db.verdicts.get(key);
    if (!row) return { rows: [] };
    db.verdicts.delete(key);
    return { rows: [row] };
  }
  if (/^SELECT m\.id, m\.exchange_record_id/.test(sql)) {
    if (params[0] !== OWNER_ID) return { rows: [] };
    const rows = db.matches.map((row) => ({
      ...row,
      ...(db.records.get(row.exchange_record_id) || {}),
      counter_record_type: db.records.get(row.counter_record_id)?.record_type ?? null,
      verdict: db.verdicts.get(verdictKey(row))?.verdict ?? null,
      total_count: db.matches.length,
    }));
    return { rows };
  }
  if (/^SELECT s\.id, s\.exchange_record_id/.test(sql)) {
    if (params[0] !== OWNER_ID) return { rows: [] };
    return {
      rows: db.suggestions.map((row) => ({
        ...row,
        ...(db.records.get(row.exchange_record_id) || {}),
        total_count: db.suggestions.length,
      })),
    };
  }
  if (/AS unmatched_records/.test(sql)) {
    const matchable = [...db.records.values()]
      .filter((r) => r.record_type === 'deposit' || r.record_type === 'withdrawal');
    const claimed = new Set(db.matches.flatMap((m) => [m.exchange_record_id, m.counter_record_id]));
    return {
      rows: [{
        matched: db.matches.length,
        suggested: db.suggestions.length,
        unmatched_records: matchable.filter((r) => !claimed.has(r.id)).length,
        unmatched_activities: db.activity.filter((a) => ['exchange_deposit', 'exchange_withdrawal'].includes(a.category)
          && !db.matches.some((m) => m.activity_id === a.id)).length,
      }],
    };
  }
  return { rows: [] };
}

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) { return fakeQuery(text, params); }
      async connect() {
        return { query: async (text, params) => fakeQuery(text, params), release() {} };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');
const ExchangeMatch = require('../src/models/ExchangeMatch');
const ExchangeMatchService = require('../src/services/ExchangeMatchService');

const { selectMatches, REVIEW_REASONS, amountEvidencePasses } = ExchangeMatchService;

// --- fixtures --------------------------------------------------------------

// One row of the on-chain candidate query, in the shape the SQL projects.
const onChainCandidate = (overrides = {}) => ({
  activity_id: 100,
  exchange_record_id: 500,
  wallet_id: WALLET_ID,
  chain_id: 1,
  tx_hash: TX,
  counterparty_address: VENUE,
  // One net leg, so counterparty_address really is the other side of the
  // transfer rather than the gas leg's to_address.
  single_net_leg: true,
  exchange_account_name: 'Kraken',
  direction_compatible: true,
  match_method: 'tx_hash',
  confidence: 'high',
  time_delta: 0,
  ...overrides,
});

const pairCandidate = (overrides = {}) => ({
  exchange_record_id: 600,
  counter_record_id: 700,
  direction_compatible: true,
  match_method: 'amount_window',
  confidence: 'medium',
  time_delta: 900,
  ...overrides,
});

const activityRow = (overrides = {}) => ({
  id: 100,
  wallet_id: WALLET_ID,
  chain_id: 1,
  tx_hash: TX,
  block_time: '2026-03-05T12:00:00.000Z',
  category: 'exchange_deposit',
  needs_review: false,
  review_reason: null,
  confidence: 'high',
  ...overrides,
});

const recordRow = (id, overrides = {}) => ({
  id,
  exchange_account_id: KRAKEN_ACCOUNT,
  record_type: 'deposit',
  occurred_at: '2026-03-05T12:05:00.000Z',
  base_asset: 'ETH',
  base_amount: '1.4',
  ...overrides,
});

const seedRecords = (...rows) => {
  for (const row of rows) db.records.set(row.id, row);
};

beforeEach(() => {
  db.onChainCandidates = [];
  db.pairCandidates = [];
  db.matches = [];
  db.suggestions = [];
  db.verdicts.clear();
  db.activity = [];
  db.labels = [];
  db.records.clear();
  db.events = [];
  queries.length = 0;
  nextMatchId = 1;
  delete process.env.DEV_AUTH_USER_ID;
});

// --- the exact-hash match --------------------------------------------------

test('a tx-hash match ties the transfer to the record and takes it out of review', async () => {
  db.activity = [activityRow({ needs_review: true, review_reason: 'was flagged' })];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate()];

  const result = await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(result.matches, 1);
  assert.deepEqual(db.matches.map((m) => [m.activity_id, m.exchange_record_id, m.match_method, m.confidence]),
    [[100, 500, 'tx_hash', 'high']]);
  // A matched transfer IS explained, and it inherits the match's certainty
  // rather than the ladder's.
  assert.equal(db.activity[0].needs_review, false);
  assert.equal(db.activity[0].review_reason, null);
  assert.equal(db.activity[0].confidence, 'high');
});

test('a compatible hash remains identity when provider amounts disagree, and preserves the warning evidence', () => {
  const candidate = onChainCandidate({
    comparison_kind: 'hash',
    comparison_left_amount: '7',
    comparison_right_amount: '6.5',
    fee_amount_applied: '0',
    amount_delta: '0.5',
    amount_tolerance: '0',
  });
  const { rows, suggestions } = selectMatches({ onChain: [candidate] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].match_method, 'tx_hash');
  assert.equal(rows[0].amount_delta, '0.5');
  assert.deepEqual(suggestions, []);
});

test('conflicting compatible hash candidates are all shown as ambiguous and none is matched', () => {
  const { rows, suggestions } = selectMatches({
    onChain: [
      onChainCandidate({ exchange_record_id: 500, activity_id: 100 }),
      onChainCandidate({ exchange_record_id: 500, activity_id: 101, chain_id: 10 }),
    ],
  });
  assert.deepEqual(rows, []);
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((row) => row.suggestion_reason === 'ambiguous'));
});

test('a hash match teaches the venue address; an amount-only suggestion never does', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate()];

  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.deepEqual(db.labels.map((l) => [l.address, l.name, l.kind, l.source]),
    [[VENUE, 'Kraken', 'exchange', 'auto-match']]);

  // Same movement, matched by asset + amount + a time window instead. That is
  // a guess, and a wrong 'exchange' label deletes real spending from cash flow
  // everywhere, forever.
  db.labels = [];
  db.matches = [];
  db.onChainCandidates = [onChainCandidate({ match_method: 'amount_window', confidence: 'medium' })];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(db.matches.length, 0, 'amount + time alone must not fold rows');
  assert.equal(db.suggestions.length, 1, 'the evidence remains visible for review');
  assert.deepEqual(db.labels, [], 'only proof may write a label');
});

test('a hash with no compatible movement direction is not automatic', async () => {
  // A multi-leg call has no single transfer direction to compare with the
  // exchange record. Hash identity alone does not satisfy the strict policy,
  // and its counterparty may merely be a router contract.
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate({ single_net_leg: false, direction_compatible: false })];

  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(db.matches.length, 0);
  assert.equal(db.suggestions.length, 0, 'no qualifying evidence remains');
  assert.deepEqual(db.labels, []);
});

test('an address the user has already judged is never re-labeled', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate()];
  // A user's explicit 'external' verdict -- paying a gateway is spending.
  db.labels = [{ user_id: OWNER_ID, address: VENUE, name: 'MoonPay', kind: 'external', source: 'user' }];

  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(db.labels.length, 1);
  assert.equal(db.labels[0].kind, 'external', 'the user always wins');

  // ...and neither is one a builtin has judged: the pack row is global
  // (user_id NULL), so writing a user row here would SHADOW it.
  db.labels = [{ user_id: null, address: VENUE, name: 'Some DEX', kind: 'external', source: 'eth-labels' }];
  db.matches = [];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(db.labels.length, 1);
});

// --- the fallback match ----------------------------------------------------

test('address and exact fee-adjusted amount is suggested but never matched automatically', async () => {
  db.activity = [activityRow({ needs_review: true })];
  seedRecords(recordRow(500, { tx_hash: null }));
  db.onChainCandidates = [onChainCandidate({
    match_method: 'address_amount', confidence: 'medium', time_delta: 300,
  })];

  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(db.matches.length, 0);
  assert.equal(db.suggestions.length, 1);
  assert.equal(db.suggestions[0].match_method, 'address_amount');
  assert.equal(db.suggestions[0].suggestion_reason, 'address_amount');
  assert.equal(db.activity[0].needs_review, true);
  assert.equal(db.activity[0].review_reason, REVIEW_REASONS.suggested_exchange);
  assert.equal(db.activity[0].confidence, 'low');
});

test('materially different amounts never survive the heuristic guard, including opposite signs', () => {
  const candidate = onChainCandidate({
    match_method: 'amount_window',
    confidence: 'low',
    comparison_kind: 'amount',
    comparison_left_amount: '-0.00000001',
    comparison_right_amount: '25',
    fee_amount_applied: '0',
  });
  assert.equal(amountEvidencePasses(candidate), false);
  assert.deepEqual(selectMatches({ onChain: [candidate] }).rows, []);
});

test('amount evidence compares magnitudes after an applicable fee and preserves direction as separate evidence', () => {
  const candidate = onChainCandidate({
    match_method: 'address_amount',
    confidence: 'medium',
    comparison_kind: 'amount',
    comparison_left_amount: '-2.00000000',
    comparison_right_amount: '1.995',
    fee_amount_applied: '0.005',
    amount_delta: '0',
    amount_tolerance: '0',
    magnitude_ratio: '0.9975',
    address_match: true,
  });
  assert.equal(amountEvidencePasses(candidate), true);
  const { rows, suggestions } = selectMatches({ onChain: [candidate] });
  assert.deepEqual(rows, []);
  assert.equal(suggestions[0].comparison_kind, 'amount');
  assert.equal(suggestions[0].amount_delta, '0');
  assert.equal(suggestions[0].amount_tolerance, '0');
  assert.equal(suggestions[0].address_match, true);
});

test('fee adjustment must be exact: a partial fee and a one-unit residual both fail', () => {
  const partialFee = onChainCandidate({
    match_method: 'address_amount',
    comparison_kind: 'amount',
    comparison_left_amount: '2',
    comparison_right_amount: '1.997',
    fee_amount_applied: '0.005',
  });
  const oneWeiResidual = onChainCandidate({
    match_method: 'address_amount',
    comparison_kind: 'amount',
    comparison_left_amount: '1',
    comparison_right_amount: '1.000000000000000001',
    fee_amount_applied: '0',
  });
  const alreadyNet = onChainCandidate({
    match_method: 'address_amount',
    comparison_kind: 'amount',
    comparison_left_amount: '2',
    comparison_right_amount: '2',
    fee_amount_applied: '0.005',
  });

  assert.equal(amountEvidencePasses(partialFee), false);
  assert.equal(amountEvidencePasses(oneWeiResidual), false);
  assert.equal(amountEvidencePasses(alreadyNet), true, 'a provider may report an already-net amount plus fee metadata');
});

test('a hash match beats a fallback match for the same record, whatever the row order', () => {
  const fallback = onChainCandidate({ activity_id: 101, match_method: 'amount_window', confidence: 'medium', time_delta: 5 });
  const exact = onChainCandidate({ activity_id: 100, match_method: 'tx_hash', confidence: 'high', time_delta: 0 });

  for (const onChain of [[fallback, exact], [exact, fallback]]) {
    const { rows } = selectMatches({ onChain });
    assert.equal(rows.length, 1, 'one record, one match');
    assert.equal(rows[0].activity_id, 100);
    assert.equal(rows[0].match_method, 'tx_hash');
  }
});

test('amount-and-time alternatives stay unmatched instead of picking the closest one', () => {
  const { rows, suggestions } = selectMatches({
    onChain: [
      onChainCandidate({ activity_id: 100, exchange_record_id: 500, match_method: 'amount_window', confidence: 'medium', time_delta: 4000 }),
      onChainCandidate({ activity_id: 101, exchange_record_id: 500, match_method: 'amount_window', confidence: 'medium', time_delta: 60 }),
      onChainCandidate({ activity_id: 101, exchange_record_id: 501, match_method: 'amount_window', confidence: 'medium', time_delta: 90 }),
    ],
  });

  assert.deepEqual(rows, []);
  assert.equal(suggestions.length, 3);
  assert.ok(suggestions.every((row) => row.suggestion_reason === 'ambiguous'));
});

test('a unique amount-and-time candidate is suggested for confirmation, never matched', () => {
  const { rows, suggestions } = selectMatches({
    onChain: [onChainCandidate({ match_method: 'amount_window', confidence: 'low' })],
  });
  assert.deepEqual(rows, []);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].suggestion_reason, 'amount_time_only');
});

// --- exchange to exchange --------------------------------------------------

test('a unique address-corroborated venue transfer remains a suggestion', async () => {
  seedRecords(
    recordRow(600, { exchange_account_id: COINBASE_ACCOUNT, record_type: 'withdrawal', base_amount: '-2.5' }),
    recordRow(700, { exchange_account_id: KRAKEN_ACCOUNT, record_type: 'deposit', base_amount: '2.4995' })
  );
  db.pairCandidates = [pairCandidate({ match_method: 'address_amount', confidence: 'medium' })];

  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(db.matches.length, 0);
  assert.equal(db.suggestions.length, 1);
  const [match] = db.suggestions;
  // The WITHDRAWAL is the anchor, so the pair has one identity rather than two
  // orderings of the same two ids.
  assert.equal(match.exchange_record_id, 600);
  assert.equal(match.counter_record_id, 700);
  assert.equal(match.activity_id, null, 'this movement never touched a tracked wallet');
});

test('an on-chain leg wins the record back from an exchange-to-exchange pairing', () => {
  // "No tracked wallet in between" is what makes a pair a pair. A record that
  // demonstrably has an on-chain leg must not be paired off against another
  // venue instead -- that would explain the same money twice, in two places.
  const { rows } = selectMatches({
    onChain: [onChainCandidate({ activity_id: 100, exchange_record_id: 600 })],
    pairs: [pairCandidate({ exchange_record_id: 600, counter_record_id: 700 })],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].activity_id, 100);
  assert.equal(rows[0].counter_record_id, null);
});

test('competing address-corroborated candidates remain unmatched and show every alternative', () => {
  const { rows, suggestions } = selectMatches({
    onChain: [onChainCandidate({
      activity_id: 100, exchange_record_id: 600, match_method: 'address_amount', confidence: 'medium',
    })],
    pairs: [pairCandidate({
      exchange_record_id: 600, counter_record_id: 700, match_method: 'address_amount', confidence: 'medium',
    })],
  });

  assert.deepEqual(rows, []);
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((row) => row.suggestion_reason === 'ambiguous'));
});

test('ambiguity is detected across address and time-only evidence tiers', () => {
  const { rows, suggestions } = selectMatches({
    onChain: [
      onChainCandidate({ activity_id: 100, exchange_record_id: 500, match_method: 'address_amount', confidence: 'medium' }),
      onChainCandidate({ activity_id: 101, exchange_record_id: 500, match_method: 'amount_window', confidence: 'low' }),
    ],
  });
  assert.deepEqual(rows, []);
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((row) => row.suggestion_reason === 'ambiguous'));
});

test('a pair the user confirmed still beats a derived on-chain candidate', () => {
  // Manual is the one key above shape: the user is overruling us, whatever
  // shape their answer took.
  const { rows } = selectMatches({
    onChain: [onChainCandidate({ activity_id: 100, exchange_record_id: 600 })],
    verdicts: [{
      exchange_record_id: 600, counter_record_id: 700, verdict: 'confirmed',
      wallet_id: null, chain_id: null, tx_hash: null, activity_id: null,
    }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].counter_record_id, 700);
  assert.equal(rows[0].match_method, 'manual');
});

// --- verdicts survive the rebuild ------------------------------------------

test('the rebuild replaces every match it derived, and does not duplicate them', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate()];

  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  const firstId = db.matches[0].id;

  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(db.matches.length, 1, 'a second rebuild must not stack a second match');
  assert.notEqual(db.matches[0].id, firstId, 'and it really is delete-then-insert');
});

test('the persistence boundary refuses to store a heuristic as an active match', async () => {
  await assert.rejects(
    () => ExchangeMatch.replaceForUser(OWNER_ID, [{
      exchange_record_id: 500,
      activity_id: 100,
      counter_record_id: null,
      match_method: 'address_amount',
      confidence: 'medium',
    }]),
    /refuses non-automatic method address_amount/
  );
});

test('a v3 rebuild invalidates a stale v2 address match and preserves explicit verdicts', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.matches = [{
    id: nextMatchId++, exchange_record_id: 500, activity_id: 100, counter_record_id: null,
    wallet_id: WALLET_ID, chain_id: 1, tx_hash: TX,
    match_method: 'address_amount', confidence: 'medium', rule_version: 'v2',
    comparison_kind: 'amount', comparison_left_amount: '1', comparison_right_amount: '1',
    fee_amount_applied: '0', amount_delta: '0', amount_tolerance: '0.005',
    magnitude_ratio: '1', address_match: true, time_delta_seconds: 30,
  }];
  const invalidated = await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(invalidated.invalidated, 1);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].prior_match_method, 'address_amount');
  assert.equal(db.events[0].amount_tolerance, '0.005');

  const repeated = await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(repeated.invalidated, 0);
  assert.equal(db.events.length, 1, 'the event key makes rebuild counts reproducible');

  db.verdicts.set(verdictKey({
    exchange_record_id: 500, wallet_id: WALLET_ID, chain_id: 1, tx_hash: TX,
  }), {
    exchange_record_id: 500,
    counter_record_id: null,
    wallet_id: WALLET_ID,
    chain_id: 1,
    tx_hash: TX,
    verdict: 'confirmed',
  });
  const confirmed = await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(confirmed.invalidated, 0);
  assert.equal(db.matches[0].match_method, 'manual');
});

test('a rejected address suggestion stays rejected through any number of rebuilds', async () => {
  db.activity = [activityRow({ needs_review: true })];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate({ match_method: 'address_amount', confidence: 'medium' })];

  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(db.matches.length, 0);
  assert.equal(db.suggestions.length, 1);

  const rejected = await request(app).post('/api/exchanges/matches/verdict').send({
    exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'rejected', note: 'different transfer',
  });
  assert.equal(rejected.status, 201);
  assert.equal(db.matches.length, 0, 'the verdict takes effect immediately');
  assert.equal(db.suggestions.length, 0, 'the rejected suggestion disappears');

  // A wallet resync: eth_activity is deleted and re-inserted, its matches
  // cascade away with it, and the pass re-derives from scratch.
  db.matches = [];
  db.activity = [activityRow({ id: 4171, needs_review: true })];
  db.onChainCandidates = [onChainCandidate({ activity_id: 4171, match_method: 'address_amount', confidence: 'medium' })];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(db.verdicts.size, 1, 'the rebuild must not touch the verdict table');
  assert.equal(db.matches.length, 0, 'and the answer still holds against a brand new activity id');
});

test('a confirmed match is re-created even when the matcher stops proposing it', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate({ match_method: 'amount_window', confidence: 'medium' })];

  const confirmed = await request(app).post('/api/exchanges/matches/verdict').send({
    exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'confirmed',
  });
  assert.equal(confirmed.status, 201);

  // The evidence disappears -- a re-import shifted the amount out of tolerance.
  db.onChainCandidates = [];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(db.matches.length, 1);
  assert.equal(db.matches[0].match_method, 'manual');
  assert.equal(db.matches[0].confidence, 'high');
});

test('a confirmation whose transaction is not in the feed is stored and inert, not dropped', () => {
  const { rows } = selectMatches({
    verdicts: [{
      exchange_record_id: 500, counter_record_id: null, verdict: 'confirmed',
      wallet_id: WALLET_ID, chain_id: 1, tx_hash: TX, activity_id: null,
    }],
  });
  assert.deepEqual(rows, []);
});

test('a verdict can be undone, which uncovers the derived match again', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate()];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  await request(app).post('/api/exchanges/matches/verdict').send({
    exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'rejected',
  });
  assert.equal(db.matches.length, 0);

  const removed = await request(app)
    .delete(`/api/exchanges/matches/verdict?exchange_record_id=500&wallet_id=${WALLET_ID}&tx_hash=${TX}`);
  assert.equal(removed.status, 200);
  assert.equal(db.matches.length, 1, 'the derived match comes back');

  const again = await request(app)
    .delete(`/api/exchanges/matches/verdict?exchange_record_id=500&wallet_id=${WALLET_ID}&tx_hash=${TX}`);
  assert.equal(again.status, 404);
});

// --- unmatched flows -------------------------------------------------------

test('an exchange flow with no record behind it goes back to needs_review', async () => {
  db.activity = [activityRow({ category: 'exchange_deposit', needs_review: false })];
  // Matching is in play: the user holds records that could have explained it.
  seedRecords(recordRow(501), recordRow(502));

  const result = await ExchangeMatchService.rebuildForUser(OWNER_ID);

  assert.equal(result.flagged, 1);
  assert.equal(db.activity[0].needs_review, true);
  assert.equal(db.activity[0].review_reason, REVIEW_REASONS.unmatched_exchange);
  assert.equal(db.activity[0].confidence, 'low');
});

test('a user who tracks no exchange transfers at all sees no new flags', async () => {
  db.activity = [activityRow({ category: 'exchange_deposit' })];

  const result = await ExchangeMatchService.rebuildForUser(OWNER_ID);

  // Labelling one address "Coinbase" must not flag every transfer to it for
  // someone who has no exchange to import. A badge that cannot reach zero gets
  // ignored, and it would take the real flags with it.
  assert.equal(result.flagged, 0);
  assert.equal(db.activity[0].needs_review, false);
});

test('trades alone do not open the gate: only transfers can explain a transfer', async () => {
  db.activity = [activityRow({ category: 'exchange_deposit' })];
  seedRecords(
    recordRow(501, { record_type: 'trade' }),
    recordRow(502, { record_type: 'reward' }),
    recordRow(503, { record_type: 'transfer' }),
  );

  const result = await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(result.flagged, 0);
  assert.deepEqual(ExchangeMatch.MATCHABLE_RECORD_TYPES, ['deposit', 'withdrawal']);
});

test('deleting an exchange account returns its matched flows to needs_review', async () => {
  db.activity = [activityRow({ needs_review: true })];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate()];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(db.activity[0].needs_review, false);

  // The cascade: the account's records go, and the matches with them. Nothing
  // dangles -- but the on-chain half is now explained by evidence that no
  // longer exists.
  db.records.clear();
  db.matches = [];
  db.onChainCandidates = [];
  seedRecords(recordRow(900, { exchange_account_id: COINBASE_ACCOUNT, occurred_at: '2026-03-01T00:00:00.000Z' }),
    recordRow(901, { exchange_account_id: COINBASE_ACCOUNT, occurred_at: '2026-03-09T00:00:00.000Z' }));

  await ExchangeMatchService.rebuildForUser(OWNER_ID);
  assert.equal(db.activity[0].needs_review, true);
  assert.equal(db.activity[0].review_reason, REVIEW_REASONS.unmatched_exchange);
});

// --- the candidate SQL -----------------------------------------------------

test('the candidate query requires exact NUMERIC amounts and uses tiered time windows', async () => {
  await ExchangeMatch.onChainCandidates(OWNER_ID);
  const { sql, params } = queries.find((q) => /^WITH scoped_activity AS/.test(q.sql));

  // The allowed residual is exactly zero. A float or percentage would both
  // lose precision and make large transfers easier to match incorrectly.
  assert.match(sql, /\$2::numeric AS amount_tolerance/);
  assert.match(sql, /evidence\.amount_delta <= evidence\.amount_tolerance/);
  assert.match(sql, /LEAST\( ABS\(sr\.base_amount - sa\.leg_amount\), ABS\(ABS\(sr\.base_amount - sa\.leg_amount\) - sr\.base_fee_amount\) \) AS amount_delta/);
  assert.doesNotMatch(sql, /leg_amount, sr\.base_amount\) \* \$\d+::numeric/);
  assert.equal(params[1], ExchangeMatch.EXACT_AMOUNT_TOLERANCE);
  assert.equal(params[3], ExchangeMatch.MATCH_WINDOW_HOURS);
  assert.equal(params[4], ExchangeMatch.AMOUNT_ONLY_WINDOW_HOURS);
  assert.match(sql, /THEN \$4::int ELSE \$5::int END/);
  assert.doesNotMatch(sql, /float|double precision/i);

  // Direction, or a deposit and a withdrawal of the same size on the same day
  // match each other.
  assert.match(sql, /sr\.record_type = CASE WHEN sa\.leg_direction = 'out' THEN 'deposit' ELSE 'withdrawal' END/);
  assert.match(sql, /sa\.leg_direction IN \('in', 'out'\)/);
  assert.match(sql, /WHERE sa\.leg_direction IN \('in', 'out'\) AND sr\.record_type = CASE/);

  // Both sides fail closed through their root tables.
  assert.match(sql, /JOIN eth_wallets w ON w\.id = a\.wallet_id/);
  assert.match(sql, /WHERE w\.user_id = \$1/);
  assert.match(sql, /JOIN exchange_accounts ea ON ea\.id = er\.exchange_account_id/);
  assert.match(sql, /WHERE ea\.user_id = \$1/);
  assert.match(sql, /evm_asset_identity_registry/);
  assert.match(sql, /sr\.base_asset_identity = sa\.leg_asset_identity/);
  assert.doesNotMatch(sql, /AND sr\.base_asset = sa\.leg_asset/);

  // The override is coalesced over the derived verdict, like every other reader.
  assert.match(sql, /COALESCE\(o\.category, a\.category\) AS category/);
});

// A same-asset fee explains a difference; it does not widen a tolerance. A fee
// in another currency cannot be converted without a source-backed rate.
test('only a same-asset fee explains an amount difference on either arm', async () => {
  await ExchangeMatch.onChainCandidates(OWNER_ID);
  await ExchangeMatch.exchangePairCandidates(OWNER_ID);
  const onChain = queries.find((q) => /^WITH scoped_activity AS/.test(q.sql)).sql;
  const pair = queries.find((q) => /^WITH scoped_records AS/.test(q.sql)).sql;

  for (const sql of [onChain, pair]) {
    // The fee only counts when it is denominated in the asset being compared.
    assert.match(sql, /CASE WHEN UPPER\(er\.fee_asset\) = UPPER\(er\.base_asset\) THEN COALESCE\(ABS\(er\.fee_amount\), 0\) ELSE 0 END AS base_fee_amount/);
    // And no percentage tolerance may reach the raw column past that guard.
   assert.match(sql, /amount_delta/);
   assert.match(sql, /amount_tolerance/);
   assert.doesNotMatch(sql, /ABS\(sr\.base_amount - sa\.leg_amount\) <= sr\.base_fee_amount \+/);
   assert.doesNotMatch(sql, /ABS\(sent\.base_amount - received\.base_amount\) <= sent\.base_fee_amount \+/);
 }

  assert.match(onChain, /LEAST\( ABS\(sr\.base_amount - sa\.leg_amount\), ABS\(ABS\(sr\.base_amount - sa\.leg_amount\) - sr\.base_fee_amount\) \)/);
  assert.match(pair, /LEAST\( ABS\(sent\.base_amount - received\.base_amount\), ABS\(ABS\(sent\.base_amount - received\.base_amount\) - sent\.base_fee_amount - received\.base_fee_amount\) \)/);
});

test('thirty ETH cannot gain a 0.15 ETH allowance from transfer size', () => {
  const candidate = onChainCandidate({
    match_method: 'address_amount',
    confidence: 'medium',
    comparison_kind: 'amount',
    comparison_left_amount: '30',
    comparison_right_amount: '29.9',
    fee_amount_applied: '0',
  });
  assert.equal(amountEvidencePasses(candidate), false);
  assert.deepEqual(selectMatches({ onChain: [candidate] }).rows, []);
});

test('the exchange-to-exchange query refuses to pair an account with itself', async () => {
  await ExchangeMatch.exchangePairCandidates(OWNER_ID);
  const { sql } = queries.find((q) => /^WITH scoped_records AS/.test(q.sql));

  // A withdrawal and a deposit on the SAME account are two unrelated movements
  // that happen to be the same size; pairing them deletes both.
  assert.match(sql, /received\.exchange_account_id <> sent\.exchange_account_id/);
  assert.match(sql, /sent\.record_type = 'withdrawal'/);
  assert.match(sql, /received\.record_type = 'deposit'/);
  assert.match(sql, /\(sent\.tx_hash IS NULL OR received\.tx_hash IS NULL\) AND evidence\.amount_delta <= evidence\.amount_tolerance/);
  assert.match(sql, /\$2::numeric/);
  assert.doesNotMatch(sql, /float|double precision/i);
});

test('the unmatched-flow flag is gated on the user tracking exchange transfers at all', async () => {
  await ExchangeMatch.flagUnmatchedExchangeFlows(OWNER_ID, 'because');
  const { sql, params } = queries.find((q) => /^UPDATE eth_activity a SET needs_review = TRUE/.test(q.sql));

  assert.match(sql, /EXISTS \( SELECT 1 FROM exchange_records er JOIN exchange_accounts ea/);
  assert.match(sql, /WHERE ea\.user_id = \$1 AND er\.record_type = ANY\(\$3::varchar\[\]\)/);
  assert.match(sql, /JOIN exchange_records sr ON sr\.id = s\.exchange_record_id JOIN exchange_accounts sea ON sea\.id = sr\.exchange_account_id/);
  assert.match(sql, /sea\.user_id = \$1/);
  assert.match(sql, /cr\.id = s\.counter_record_id AND cea\.user_id = \$1/);
  assert.deepEqual(params[2], ['deposit', 'withdrawal']);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM exchange_matches m WHERE m\.activity_id = a\.id\)/);
  assert.match(sql, /unavailable_ea\.records_unavailable = TRUE/);
  assert.match(sql, /AND NOT EXISTS \( SELECT 1 FROM eth_address_labels l JOIN exchange_accounts unavailable_ea/);
  assert.doesNotMatch(sql, /OR EXISTS \( SELECT 1 FROM eth_address_labels l JOIN exchange_accounts ea/);
  assert.match(sql, /w\.user_id = \$1/);
});

test('every category test resolves the override, not just the candidate query', async () => {
  // Three readers, one category. The candidate query already coalesced; the
  // flag pass and the summary did not, so a transaction the user corrected
  // AWAY from an exchange flow generated no candidates and was then flagged
  // for having none -- a review nothing could satisfy.
  await ExchangeMatch.flagUnmatchedExchangeFlows(OWNER_ID, 'because');
  await ExchangeMatch.summaryForUser(OWNER_ID);
  const flag = queries.find((q) => /^UPDATE eth_activity a SET needs_review = TRUE/.test(q.sql)).sql;
  const summary = queries.find((q) => /AS unmatched_records/.test(q.sql)).sql;

  for (const sql of [flag, summary]) {
    assert.match(sql, /eth_activity_overrides o/);
    assert.match(sql, /IN \('exchange_deposit', 'exchange_withdrawal'\)/);
    // No reader may test the derived column on its own.
    assert.doesNotMatch(sql, /a\.category IN \(/);
  }
});

test('a suggestion review reason does not depend on whether the row was already flagged', async () => {
  // Same data, two histories: synced before the record existed (flagged, then
  // cleared) and synced after (never flagged). Both must end up saying the
  // match's confidence, not the ladder's.
  const run = async (needsReview) => {
    db.matches = [];
    db.activity = [activityRow({ needs_review: needsReview, confidence: 'high' })];
    seedRecords(recordRow(500));
    db.onChainCandidates = [onChainCandidate({ match_method: 'address_amount', confidence: 'medium' })];
    await ExchangeMatchService.rebuildForUser(OWNER_ID);
    return db.activity[0];
  };

  const flaggedFirst = await run(true);
  const neverFlagged = await run(false);
  assert.equal(flaggedFirst.confidence, 'low');
  assert.equal(neverFlagged.confidence, 'low');
  assert.equal(neverFlagged.needs_review, true);
  assert.equal(flaggedFirst.review_reason, REVIEW_REASONS.suggested_exchange);
  assert.equal(neverFlagged.review_reason, REVIEW_REASONS.suggested_exchange);
});

test('the verdict statements gate the wallet as well as the record', async () => {
  // exchange_match_verdicts is reached through the RECORD's account, which
  // says nothing about the wallet id bound alongside it.
  await ExchangeMatch.verdictsForUser(OWNER_ID);
  const read = queries.find((q) => /^SELECT v\.id, v\.exchange_record_id, v\.counter_record_id, v\.verdict/.test(q.sql)).sql;
  assert.match(read, /EXISTS \(SELECT 1 FROM eth_wallets w WHERE w\.id = a\.wallet_id AND w\.user_id = \$1\)/);

  seedRecords(recordRow(500));
  const foreign = await ExchangeMatch.upsertVerdict(OWNER_ID, {
    exchangeRecordId: 500, walletId: FOREIGN_WALLET_ID, chainId: 1, txHash: TX, verdict: 'confirmed',
  });
  const write = queries.find((q) => /^INSERT INTO exchange_match_verdicts/.test(q.sql)).sql;
  // Cast on BOTH uses of $2, or Postgres deduces two types for one parameter
  // and refuses the statement.
  assert.match(write, /SELECT er\.id, \$2::int,/);
  assert.match(write, /EXISTS \( SELECT 1 FROM eth_wallets w WHERE w\.id = \$2::int AND w\.user_id = \$8 \)/);
  assert.equal(foreign, null, 'the model refuses it even with the route check bypassed');
  assert.equal(db.verdicts.size, 0);
});

// --- routes and scoping ----------------------------------------------------

test('match reads and writes refuse to run unscoped', async () => {
  await assert.rejects(() => ExchangeMatch.onChainCandidates(undefined), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.exchangePairCandidates(null), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.verdictsForUser(undefined), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.replaceForUser(undefined, []), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.findForUser(null), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.findSuggestionsForUser(null), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.summaryForUser(undefined), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.clearReviewForMatched(null), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.flagUnmatchedExchangeFlows(undefined, 'x'), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.learnExchangeLabel(undefined, VENUE, 'Kraken'), /requires a userId/);
  await assert.rejects(() => ExchangeMatch.verdictTargetExists(null, {}), /requires a userId/);
  await assert.rejects(
    () => ExchangeMatch.upsertVerdict(undefined, { exchangeRecordId: 1, verdict: 'confirmed' }),
    /requires a userId/
  );
  await assert.rejects(() => ExchangeMatch.deleteVerdict(null, { exchangeRecordId: 1 }), /requires a userId/);
  await assert.rejects(() => ExchangeMatchService.rebuildForUser(undefined), /requires a userId/);
});

test('GET /api/exchanges/matches serves only the caller own matches', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  db.onChainCandidates = [onChainCandidate()];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  const mine = await request(app).get('/api/exchanges/matches');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.length, 1);
  assert.deepEqual(mine.body.suggestions, []);
  assert.equal(mine.body.summary.matched, 1);
  assert.equal(mine.body.summary.unmatchedRecords, 0);

  process.env.DEV_AUTH_USER_ID = '2';
  const theirs = await request(app).get('/api/exchanges/matches');
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.body.data, []);
  assert.deepEqual(theirs.body.suggestions, []);
});

test('GET /api/exchanges/matches exposes review suggestions without counting them as matches', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500, { tx_hash: null }));
  db.onChainCandidates = [onChainCandidate({
    match_method: 'address_amount', confidence: 'medium', comparison_kind: 'amount',
    comparison_left_amount: '1.4', comparison_right_amount: '1.4',
    fee_amount_applied: '0', amount_delta: '0', amount_tolerance: '0', address_match: true,
  })];
  await ExchangeMatchService.rebuildForUser(OWNER_ID);

  const response = await request(app).get('/api/exchanges/matches');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, []);
  assert.equal(response.body.suggestions.length, 1);
  assert.equal(response.body.suggestions[0].suggestion_reason, 'address_amount');
  assert.equal(response.body.summary.matched, 0);
  assert.equal(response.body.summary.suggested, 1);
});

test('a verdict must name exactly one shape', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500), recordRow(700));

  const neither = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, verdict: 'confirmed' });
  assert.equal(neither.status, 400);
  assert.match(neither.body.error, /counter_record_id/);

  const both = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, counter_record_id: 700, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'confirmed' });
  assert.equal(both.status, 400);

  const badHash = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: '0x1234', verdict: 'confirmed' });
  assert.equal(badHash.status, 400);
  assert.match(badHash.body.error, /tx_hash/);

  const badVerdict = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'maybe' });
  assert.equal(badVerdict.status, 400);
  assert.match(badVerdict.body.error, /verdict must be one of/);

  const selfPair = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, counter_record_id: 500, verdict: 'confirmed' });
  assert.equal(selfPair.status, 400);
});

test('a verdict may only name records that could be half of a movement', async () => {
  db.activity = [activityRow()];
  // A trade has no counterpart to be the same money as, and the matcher would
  // never propose it -- so confirming it stores an answer to a question that
  // cannot be asked.
  seedRecords(recordRow(500, { record_type: 'trade' }), recordRow(700));

  const trade = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'confirmed' });
  assert.equal(trade.status, 400);
  assert.match(trade.body.error, /trade/);
  assert.equal(db.verdicts.size, 0);
});

test('a pair verdict has to run withdrawal -> deposit', async () => {
  // The derived pair query anchors on the withdrawal so a movement has one
  // identity rather than two orderings of the same two ids. A verdict stored
  // the other way round would never line up with the match it answers.
  seedRecords(
    recordRow(600, { exchange_account_id: COINBASE_ACCOUNT, record_type: 'withdrawal' }),
    recordRow(700, { record_type: 'deposit' })
  );

  const backwards = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 700, counter_record_id: 600, verdict: 'confirmed' });
  assert.equal(backwards.status, 400);
  assert.match(backwards.body.error, /withdrawal -> deposit/);

  const rightWayRound = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 600, counter_record_id: 700, verdict: 'confirmed' });
  assert.equal(rightWayRound.status, 201);
});

test('a second confirmation claiming the same record is refused, not silently dropped', async () => {
  db.activity = [activityRow()];
  seedRecords(
    recordRow(600, { exchange_account_id: COINBASE_ACCOUNT, record_type: 'withdrawal' }),
    recordRow(700, { record_type: 'deposit' })
  );

  const pair = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 600, counter_record_id: 700, verdict: 'confirmed' });
  assert.equal(pair.status, 201);

  // The two verdicts sit under DIFFERENT unique keys, so the database takes
  // both and the selection pass then discards one by an ordering the user
  // never sees. The same money cannot be explained twice.
  const onChain = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 600, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'confirmed' });
  assert.equal(onChain.status, 409);
  assert.match(onChain.body.error, /already claims/);
  assert.equal(db.verdicts.size, 1);

  // A REJECTION is not a claim, so it is always allowed.
  const rejection = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 600, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'rejected' });
  assert.equal(rejection.status, 201);

  // And re-answering the SAME pair is an update, not a conflict.
  const again = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 600, counter_record_id: 700, verdict: 'confirmed', note: 'still sure' });
  assert.equal(again.status, 201);
});

test('a verdict against something the caller cannot see is a 404, not an invisible write', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));

  // A hash this wallet never saw.
  const orphan = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: TX2, verdict: 'confirmed' });
  assert.equal(orphan.status, 404);

  // A record that is not this user's.
  const foreignRecord = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 9999, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'confirmed' });
  assert.equal(foreignRecord.status, 404);

  // A wallet that is not this user's.
  const foreignWallet = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, wallet_id: FOREIGN_WALLET_ID, tx_hash: TX, verdict: 'confirmed' });
  assert.equal(foreignWallet.status, 404);

  assert.equal(db.verdicts.size, 0, 'nothing may be written for an unseen pair');
});

test('a second user cannot write a verdict on the first user pair', async () => {
  db.activity = [activityRow()];
  seedRecords(recordRow(500));
  process.env.DEV_AUTH_USER_ID = '2';

  const response = await request(app).post('/api/exchanges/matches/verdict')
    .send({ exchange_record_id: 500, wallet_id: WALLET_ID, tx_hash: TX, verdict: 'confirmed' });

  assert.equal(response.status, 404);
  assert.equal(db.verdicts.size, 0);
});
