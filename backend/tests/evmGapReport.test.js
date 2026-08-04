'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pool = require('../src/config/database');
const {
  buildReport, reviewBlocker, unpricedReason,
} = require('../scripts/report-evm-history-gaps');

test('review blockers preserve notes, selector limits, and ownership decisions', () => {
  assert.equal(reviewBlocker({ override_note: 'Possibly mine' }), 'note_preserves_review_without_verdict');
  assert.equal(reviewBlocker({ label_kind: 'external' }), 'counterparty_known_but_intent_not_proven');
  assert.equal(reviewBlocker({ method_id: '0x12345678' }), 'selector_is_display_only');
  assert.equal(reviewBlocker({}), 'ownership_or_intent_decision_required');
});

test('unpriced reasons never turn unavailable evidence into zero', () => {
  assert.equal(unpricedReason({ ignored: true }), 'user_ignored_asset');
  assert.equal(unpricedReason({ quarantined: true }), 'quarantined_spam_evidence');
  assert.equal(unpricedReason({ price_coverage_status: 'unlisted' }), 'price_coverage_unlisted');
  assert.equal(unpricedReason({ transfer_type: 'native', token_contract: null }), 'native_price_missing_for_date');
  assert.equal(unpricedReason({ transfer_type: 'token', token_contract: null }), 'malformed_or_missing_contract');
  assert.equal(unpricedReason({ transfer_type: 'token', token_contract: '0x1', token_symbol: '' }), 'malformed_or_missing_symbol');
  assert.equal(unpricedReason({ transfer_type: 'token', token_contract: '0x1', token_symbol: 'ABC' }), 'no_stored_contract_price_for_date');
});

test('the private gap report distinguishes every evidence-first bridge state', async (t) => {
  const originalQuery = pool.query;
  t.after(() => { pool.query = originalQuery; });
  pool.query = async (sql) => {
    if (/to_regclass/.test(sql)) return { rows: [{ exists: true }] };
    if (/FROM eth_bridge_movements m/.test(sql)) {
      return { rows: [{ id: 1, status: 'pending' }, { id: 2, status: 'unsupported' }] };
    }
    if (/FROM eth_bridge_suggestions s/.test(sql)) {
      return { rows: [{ id: 3, ambiguous: true }, { id: 4, ambiguous: false }] };
    }
    if (/FROM eth_bridge_verdicts v/.test(sql)) return { rows: [{ id: 5, verdict: 'rejected' }] };
    if (/FROM eth_bridge_receipt_attempts a/.test(sql)) return { rows: [{ id: 6, status: 'failed' }] };
    return { rows: [] };
  };

  const report = await buildReport(7);
  assert.equal(report.summary.bridge_evidence_model_available, true);
  assert.deepEqual(report.summary.bridge_movements_by_status, { pending: 1, unsupported: 1 });
  assert.equal(report.summary.bridge_suggestions, 2);
  assert.equal(report.summary.bridge_ambiguous_suggestions, 1);
  assert.equal(report.summary.bridge_verdicts, 1);
  assert.equal(report.summary.bridge_receipt_failures, 1);
  assert.equal(report.bridge_movements.length, 2);
});

test('the private gap report remains compatible before migration 072 deploys', async (t) => {
  const originalQuery = pool.query;
  const evidenceQueries = [];
  t.after(() => { pool.query = originalQuery; });
  pool.query = async (sql) => {
    if (/to_regclass/.test(sql)) return { rows: [{ exists: false }] };
    if (/eth_bridge_(?:movements|suggestions|verdicts|receipt_attempts)/.test(sql)) {
      evidenceQueries.push(sql);
    }
    return { rows: [] };
  };

  const report = await buildReport(7);
  assert.equal(report.summary.bridge_evidence_model_available, false);
  assert.deepEqual(evidenceQueries, []);
});
