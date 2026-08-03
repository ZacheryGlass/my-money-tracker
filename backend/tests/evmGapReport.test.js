'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const { reviewBlocker, unpricedReason } = require('../scripts/report-evm-history-gaps');

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
