'use strict';

const express = require('express');
const pool = require('../config/database');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');
const { SPEND_ELIGIBILITY_SQL } = require('../utils/spendFilters');

const router = express.Router();

router.use(requireUser);

function isValidDate(dateString) {
  if (!dateString) return true;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

// Sortable columns, keyed by the id the client sends. Whitelisted because the
// expression is interpolated into the ORDER BY clause.
const SORT_COLUMNS = {
  date: 't.date',
  name: 'COALESCE(NULLIF(TRIM(t.merchant_name), \'\'), t.name)',
  category: 't.category',
  account_name: 'COALESCE(NULLIF(TRIM(a.display_name), \'\'), a.name)',
  amount: 't.amount'
};

// GET /api/transactions - List transactions with filtering, sorting and pagination
router.get('/', async (req, res) => {
  try {
    const {
      account_id,
      startDate,
      endDate,
      view,
      sort = 'date',
      direction = 'desc',
      limit = 50,
      offset = 0
    } = req.query;

    const sortColumn = SORT_COLUMNS[sort];
    if (!sortColumn) {
      return res.status(400).json({
        error: `Invalid sort parameter. Must be one of: ${Object.keys(SORT_COLUMNS).join(', ')}.`
      });
    }
    const sortDirection = String(direction).toLowerCase();
    if (sortDirection !== 'asc' && sortDirection !== 'desc') {
      return res.status(400).json({ error: 'Invalid direction parameter. Must be asc or desc.' });
    }

    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);

    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 10000.' });
    }
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    const conditions = ['a.is_hidden = FALSE', 'a.user_id = $1'];
    const params = [req.user.id];
    let paramIndex = 2;

    // Spending-page default: restrict to spend-eligible transactions using the
    // app-wide canonical filter (excludes transfers, credit-card payments,
    // income/inflows and pending). Omitted/any other `view` returns the full
    // ledger, so AccountsPage's per-account list is unaffected.
    if (String(view).toLowerCase() === 'spend') {
      conditions.push(SPEND_ELIGIBILITY_SQL);
    } else if (!account_id) {
      // Mirrored CRYPTO_* rows live on the Crypto page; the general
      // all-transactions feed skips crypto accounts unless a specific
      // account's ledger is requested.
      conditions.push(`a.type <> 'crypto'`);
    }

    if (account_id) {
      const parsedAccountId = parseInt(account_id);
      if (isNaN(parsedAccountId)) {
        return res.status(400).json({ error: 'Invalid account_id parameter.' });
      }
      conditions.push(`t.account_id = $${paramIndex}`);
      params.push(parsedAccountId);
      paramIndex++;
    }

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`t.date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`t.date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    const dataResult = await pool.query(
      `SELECT t.id, t.account_id, t.plaid_transaction_id, t.date, t.name,
              t.merchant_name, t.amount, t.currency_code, t.category, t.pending,
              COALESCE(NULLIF(TRIM(a.display_name), ''), a.name) as account_name,
              a.name as account_source_name,
              a.display_name as account_display_name,
              efm.id AS exchange_fiat_match_id,
              er.external_id AS exchange_fiat_external_id,
              ea.name AS exchange_fiat_account_name
       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       LEFT JOIN exchange_fiat_matches efm ON efm.transaction_id = t.id
       LEFT JOIN exchange_records er ON er.id = efm.exchange_record_id
       LEFT JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       ${whereClause}
       ORDER BY ${sortColumn} ${sortDirection === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, t.id DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parsedLimit, parsedOffset]
    );

    res.status(200).json({
      data: dataResult.rows,
      pagination: { total, limit: parsedLimit, offset: parsedOffset }
    });
  } catch (error) {
    logger.error({ err: error }, 'Get transactions error');
    res.status(500).json({ error: 'Server error retrieving transactions' });
  }
});

module.exports = router;
