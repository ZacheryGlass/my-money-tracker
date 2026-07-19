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

function classify(transaction) {
  const category = transaction.category || '';
  const mapped = CATEGORY_DIRECTIONS[category];
  if (mapped) {
    return {
      direction: mapped,
      isInternalTransfer: mapped === 'internal_transfer',
      confidence: 0.9,
    };
  }
  // Plaid convention: positive amounts leave the account, negative arrive.
  const amount = Number(transaction.amount) || 0;
  return {
    direction: amount >= 0 ? 'spending' : 'income',
    isInternalTransfer: false,
    confidence: 0.5,
  };
}

// Classify every transaction that has no classification row yet. Idempotent;
// safe to run on every sync.
async function backfill() {
  const unclassified = await pool.query(`
    SELECT t.id, t.category, t.amount
    FROM transactions t
    LEFT JOIN transaction_classifications tc ON tc.transaction_id = t.id
    WHERE tc.transaction_id IS NULL
  `);
  if (!unclassified.rows.length) return { classified: 0 };

  const ids = [];
  const directions = [];
  const internals = [];
  const confidences = [];
  for (const row of unclassified.rows) {
    const result = classify(row);
    ids.push(row.id);
    directions.push(result.direction);
    internals.push(result.isInternalTransfer);
    confidences.push(result.confidence);
  }

  await pool.query(`
    INSERT INTO transaction_classifications (transaction_id, direction, is_internal_transfer, confidence)
    SELECT * FROM UNNEST($1::int[], $2::varchar[], $3::boolean[], $4::numeric[])
    ON CONFLICT (transaction_id) DO NOTHING
  `, [ids, directions, internals, confidences]);

  logger.info({ classified: ids.length }, 'Transaction classification backfill completed');
  return { classified: ids.length };
}

module.exports = { classify, backfill, CATEGORY_DIRECTIONS };
