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

module.exports = router;
