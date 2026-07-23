'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');

// Category-first mapping onto transaction_classifications.direction. Uppercase
// categories come from Plaid spending accounts, lowercase from investment
// account feeds.
const CATEGORY_DIRECTIONS = {
  transfer: 'internal_transfer',
  TRANSFER_IN: 'internal_transfer',
  TRANSFER_OUT: 'internal_transfer',
  LOAN_PAYMENTS: 'debt_payment',
  INCOME: 'income',
  dividend: 'dividend',
  interest: 'interest',
  buy: 'investment_contribution',
  contribution: 'investment_contribution',
  deposit: 'investment_contribution',
  sell: 'investment_withdrawal',
  withdrawal: 'investment_withdrawal',
  'margin expense': 'fee',
  'miscellaneous fee': 'fee',
  BANK_FEES: 'fee',
};

// Plaid's detailed category resolves cases the primary category gets wrong.
// LOAN_PAYMENTS covers both paying a mortgage (real spending) and paying a
// credit card off from checking (moving money between your own accounts).
const DETAILED_DIRECTIONS = {
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'internal_transfer',
  INCOME_DIVIDENDS: 'dividend',
  INCOME_INTEREST_EARNED: 'interest',
};

// Plaid grades its own enrichment; use its grade rather than a flat 0.9.
const CONFIDENCE_LEVELS = {
  VERY_HIGH: 0.95,
  HIGH: 0.85,
  MEDIUM: 0.6,
  LOW: 0.4,
  UNKNOWN: 0.5,
};

function classify(transaction) {
  const category = transaction.category || '';
  // Only spending-account rows carry a detailed category. Investment-feed rows
  // have lowercase primary categories and a NULL detailed one, so this override
  // never touches them.
  const detailed = transaction.detailed_category || null;
  const graded = CONFIDENCE_LEVELS[transaction.category_confidence];

  if (detailed && DETAILED_DIRECTIONS[detailed]) {
    const direction = DETAILED_DIRECTIONS[detailed];
    return {
      direction,
      isInternalTransfer: direction === 'internal_transfer',
      confidence: graded ?? 0.9,
    };
  }

  const mapped = CATEGORY_DIRECTIONS[category];
  if (mapped) {
    return {
      direction: mapped,
      isInternalTransfer: mapped === 'internal_transfer',
      confidence: graded ?? 0.9,
    };
  }
  // Plaid convention: positive amounts leave the account, negative arrive.
  // Plaid's confidence grades its category, which this branch did not use, so
  // the flat fallback confidence stands.
  const amount = Number(transaction.amount) || 0;
  return {
    direction: amount >= 0 ? 'spending' : 'income',
    isInternalTransfer: false,
    confidence: 0.5,
  };
}

// Re-derives every classification rather than only filling gaps: Plaid restates
// enrichment on existing transactions (a NULL detailed category becomes populated
// on a later sync), and an insert-if-missing pass would never revisit them.
//
// The upsert deliberately writes only the three derived columns. normalized_category,
// is_essential, is_one_time, is_refund, is_reimbursement and notes are omitted so
// they survive; this service is the sole writer of direction, so nothing manual is
// clobbered by overwriting it.
async function backfill() {
  const transactions = await pool.query(`
    SELECT t.id, t.category, t.amount, t.detailed_category, t.category_confidence
    FROM transactions t
  `);
  if (!transactions.rows.length) return { classified: 0 };

  const ids = [];
  const directions = [];
  const internals = [];
  const confidences = [];
  for (const row of transactions.rows) {
    const result = classify(row);
    ids.push(row.id);
    directions.push(result.direction);
    internals.push(result.isInternalTransfer);
    confidences.push(result.confidence);
  }

  await pool.query(`
    INSERT INTO transaction_classifications (transaction_id, direction, is_internal_transfer, confidence)
    SELECT * FROM UNNEST($1::int[], $2::varchar[], $3::boolean[], $4::numeric[])
    ON CONFLICT (transaction_id) DO UPDATE
    SET direction = EXCLUDED.direction,
        is_internal_transfer = EXCLUDED.is_internal_transfer,
        confidence = EXCLUDED.confidence,
        updated_at = CURRENT_TIMESTAMP
  `, [ids, directions, internals, confidences]);

  logger.info({ classified: ids.length }, 'Transaction classification backfill completed');
  return { classified: ids.length };
}

module.exports = { classify, backfill, CATEGORY_DIRECTIONS, DETAILED_DIRECTIONS };
