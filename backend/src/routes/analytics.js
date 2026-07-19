'use strict';

const express = require('express');
const pool = require('../config/database');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');
const BenchmarkService = require('../services/BenchmarkService');

const router = express.Router();

router.use(requireUser);

function isValidDate(dateString) {
  if (!dateString) return true;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

// GET /api/analytics/benchmark-history
router.get('/benchmark-history', async (req, res) => {
  try {
    const { symbol, startDate, endDate } = req.query;

    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol parameter is required.' });
    }
    const normalizedSymbol = symbol.toUpperCase();
    if (!BenchmarkService.SYMBOLS.includes(normalizedSymbol)) {
      return res.status(400).json({ error: `Invalid symbol. Must be one of: ${BenchmarkService.SYMBOLS.join(', ')}.` });
    }

    const conditions = ['UPPER(symbol) = $1'];
    const params = [normalizedSymbol];
    let paramIndex = 2;

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`price_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`price_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(`
      SELECT TO_CHAR(price_date, 'YYYY-MM-DD') as date, adjusted_close
      FROM benchmark_prices
      ${whereClause}
      ORDER BY price_date ASC
    `, params);

    const data = result.rows.map((row) => ({
      date: row.date,
      close: Number(row.adjusted_close),
    }));

    res.json({ data });
  } catch (error) {
    logger.error({ err: error }, 'Get benchmark history error');
    res.status(500).json({ error: 'Server error retrieving benchmark history' });
  }
});

// GET /api/analytics/detected-subscriptions
router.get('/detected-subscriptions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(t.merchant_name, t.name) as merchant,
        ROUND(AVG(t.amount)::numeric, 2) as avg_amount,
        COUNT(*)::int as occurrence_count,
        MAX(t.date) as last_charge,
        MIN(t.date) as first_charge,
        (ARRAY_AGG(t.category ORDER BY t.date DESC))[1] as category
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      WHERE t.amount > 0 AND t.pending = false AND a.is_hidden = FALSE
        AND a.type IN ('depository', 'credit')
        AND UPPER(COALESCE(t.category, '')) NOT LIKE '%TRANSFER%'
      GROUP BY COALESCE(t.merchant_name, t.name)
      HAVING COUNT(*) >= 3
         AND STDDEV(t.amount) < 5
         AND (MAX(t.date) - MIN(t.date)) > 60
      ORDER BY ROUND(AVG(t.amount)::numeric, 2) DESC
    `);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get detected subscriptions error');
    res.status(500).json({ error: 'Server error detecting subscriptions' });
  }
});

module.exports = router;
