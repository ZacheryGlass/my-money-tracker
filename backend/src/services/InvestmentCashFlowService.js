'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');

// Projects investment-account transactions into investment_cash_flows, which
// timeWeightedReturn and xirr need in order to separate contributions from
// performance. Without it both functions run on an empty flow set and report
// deposits as investment gains.
//
// is_external is the load-bearing field: it is true only for money crossing the
// portfolio boundary. Dividends, interest and fees are already reflected in
// market value, so counting them as flows would double-count them. buy/sell are
// deliberately absent -- they are internal reallocations and live in `trades`.
//
// Direction comes from the category, never from the sign. Plaid's documented
// convention (positive = cash debited) does not hold across institutions: the
// `contribution` rows in this database are positive despite being money in.
// The subtype already tells us which way the money moved, so the magnitude is
// all that is read off the amount.
const FLOW_RULES = {
  contribution: { flowType: 'contribution', isExternal: true, direction: 'in' },
  deposit: { flowType: 'contribution', isExternal: true, direction: 'in' },
  withdrawal: { flowType: 'withdrawal', isExternal: true, direction: 'out' },
  dividend: { flowType: 'dividend', isExternal: false, direction: 'in' },
  interest: { flowType: 'interest', isExternal: false, direction: 'in' },
  'margin expense': { flowType: 'fee', isExternal: false, direction: 'out' },
  'miscellaneous fee': { flowType: 'fee', isExternal: false, direction: 'out' },
  // Ambiguous: a transfer may be new outside money or a move between accounts
  // already tracked here. Treated as internal so it cannot silently distort
  // returns; the sign is the only available hint at direction.
  transfer: { flowType: null, isExternal: false, direction: 'sign' },
};

const FLOW_CATEGORIES = Object.keys(FLOW_RULES);

// Returns the investment_cash_flows row for a transaction, or null when the
// category is not a cash event. Exported for testing.
function deriveFlow(transaction) {
  const rule = FLOW_RULES[transaction.category];
  if (!rule) return null;

  const rawAmount = Number(transaction.amount) || 0;
  const magnitude = Math.abs(rawAmount);

  if (rule.direction === 'sign') {
    // Plaid credits cash with a negative amount, so negative means money in.
    const isInbound = rawAmount < 0;
    return {
      flowType: isInbound ? 'transfer_in' : 'transfer_out',
      isExternal: false,
      amount: isInbound ? magnitude : -magnitude,
    };
  }

  return {
    flowType: rule.flowType,
    isExternal: rule.isExternal,
    amount: rule.direction === 'in' ? magnitude : -magnitude,
  };
}

// Insert flows for transactions that do not have one yet. Idempotent, so it is
// safe to run on every sync -- mirrors TransactionClassificationService.backfill.
async function backfill() {
  const pending = await pool.query(
    `SELECT t.id, t.account_id, t.date, t.category, t.amount
     FROM transactions t
     LEFT JOIN investment_cash_flows f ON f.transaction_id = t.id
     WHERE f.id IS NULL AND t.category = ANY($1::text[])
     ORDER BY t.date, t.id`,
    [FLOW_CATEGORIES]
  );
  if (!pending.rows.length) return { created: 0, external: 0, ambiguousTransfers: 0 };

  const accountIds = [];
  const dates = [];
  const amounts = [];
  const flowTypes = [];
  const externals = [];
  const transactionIds = [];
  let external = 0;
  let ambiguousTransfers = 0;

  for (const row of pending.rows) {
    const flow = deriveFlow(row);
    if (!flow) continue;
    accountIds.push(row.account_id);
    dates.push(row.date);
    amounts.push(flow.amount);
    flowTypes.push(flow.flowType);
    externals.push(flow.isExternal);
    transactionIds.push(row.id);
    if (flow.isExternal) external++;
    if (row.category === 'transfer') ambiguousTransfers++;
  }

  if (!transactionIds.length) return { created: 0, external: 0, ambiguousTransfers: 0 };

  await pool.query(
    `INSERT INTO investment_cash_flows (account_id, flow_date, amount, flow_type, is_external, transaction_id)
     SELECT * FROM UNNEST($1::int[], $2::date[], $3::numeric[], $4::varchar[], $5::boolean[], $6::int[])
     ON CONFLICT (transaction_id) WHERE transaction_id IS NOT NULL DO NOTHING`,
    [accountIds, dates, amounts, flowTypes, externals, transactionIds]
  );

  if (ambiguousTransfers) {
    logger.info(
      { ambiguousTransfers },
      'Investment transfers recorded as internal; review if any were external contributions'
    );
  }
  logger.info({ created: transactionIds.length, external }, 'Investment cash flow backfill completed');
  return { created: transactionIds.length, external, ambiguousTransfers };
}

module.exports = { backfill, deriveFlow, FLOW_RULES };
