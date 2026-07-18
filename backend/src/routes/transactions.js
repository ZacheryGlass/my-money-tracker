'use strict';

const express = require('express');
const pool = require('../config/database');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);

function isValidDate(dateString) {
  if (!dateString) return true;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

// GET /api/transactions - List transactions with filtering and pagination
router.get('/', async (req, res) => {
  try {
    const {
      account_id,
      startDate,
      endDate,
      limit = 50,
      offset = 0
    } = req.query;

    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);

    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 10000.' });
    }
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    const conditions = ['a.is_hidden = FALSE'];
    const params = [];
    let paramIndex = 1;

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
              a.display_name as account_display_name
       FROM transactions t
       JOIN accounts a ON t.account_id = a.id
       ${whereClause}
       ORDER BY t.date DESC, t.id DESC
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
