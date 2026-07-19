'use strict';

const express = require('express');
const pool = require('../config/database');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');
const FinancialQueryService = require('../services/FinancialQueryService');

const router = express.Router();

router.use(requireUser);

function isValidDate(dateString) {
  if (!dateString) return true;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

// GET /api/analytics/net-worth-monthly
router.get('/net-worth-monthly', async (req, res) => {
  try {
    const { year, startDate, endDate } = req.query;

    const conditions = ['a.is_hidden = FALSE'];
    const params = [];
    let paramIndex = 1;

    if (year) {
      const parsedYear = parseInt(year);
      if (isNaN(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
        return res.status(400).json({ error: 'Invalid year parameter.' });
      }
      conditions.push(`acs.snapshot_date >= $${paramIndex}`);
      params.push(`${parsedYear}-01-01`);
      paramIndex++;
      conditions.push(`acs.snapshot_date <= $${paramIndex}`);
      params.push(`${parsedYear}-12-31`);
      paramIndex++;
    }

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`acs.snapshot_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`acs.snapshot_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(`
      WITH daily_totals AS (
        SELECT acs.snapshot_date, SUM(acs.total_value) as total_value
        FROM account_snapshots acs
        JOIN accounts a ON acs.account_id = a.id
        ${whereClause}
        GROUP BY acs.snapshot_date
      ),
      monthly AS (
        SELECT
          DATE_TRUNC('month', snapshot_date) as month,
          (ARRAY_AGG(total_value ORDER BY snapshot_date DESC))[1] as end_value
        FROM daily_totals
        GROUP BY DATE_TRUNC('month', snapshot_date)
        ORDER BY month ASC
      )
      SELECT
        month,
        end_value,
        end_value - LAG(end_value) OVER (ORDER BY month) as change,
        CASE
          WHEN LAG(end_value) OVER (ORDER BY month) > 0
          THEN ((end_value - LAG(end_value) OVER (ORDER BY month)) / LAG(end_value) OVER (ORDER BY month)) * 100
          ELSE NULL
        END as change_percent
      FROM monthly
    `, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get net worth monthly error');
    res.status(500).json({ error: 'Server error retrieving monthly net worth' });
  }
});

// GET /api/analytics/spending-by-category
router.get('/spending-by-category', async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'month' } = req.query;

    if (!['month', 'week'].includes(groupBy)) {
      return res.status(400).json({ error: 'Invalid groupBy parameter. Must be month or week.' });
    }

    const conditions = ['t.amount > 0', 't.pending = false', 'a.is_hidden = FALSE'];
    const params = [];
    let paramIndex = 1;

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
    const truncExpr = groupBy === 'month' ? "DATE_TRUNC('month', t.date)" : "DATE_TRUNC('week', t.date)";

    const result = await pool.query(`
      SELECT
        ${truncExpr} as period,
        COALESCE(t.category, 'Uncategorized') as category,
        SUM(t.amount)::numeric(15,2) as total,
        COUNT(*)::int as tx_count
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      ${whereClause}
      GROUP BY ${truncExpr}, COALESCE(t.category, 'Uncategorized')
      ORDER BY period DESC, total DESC
    `, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get spending by category error');
    res.status(500).json({ error: 'Server error retrieving spending by category' });
  }
});

// Categories that move money between the user's own accounts (transfers,
// credit card payments, investment buys/sells) rather than true income or
// spending. Counting them double-counts card purchases and inflates both sides.
const NON_CASH_FLOW_CATEGORIES = [
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'LOAN_PAYMENTS',
  'BUY',
  'SELL',
  'CONTRIBUTION',
  'WITHDRAWAL',
  'DIVIDEND',
];

// GET /api/analytics/income-vs-spending
router.get('/income-vs-spending', async (req, res) => {
  try {
    const { startDate, endDate, account_id: accountId } = req.query;

    const conditions = [
      't.pending = false',
      'a.is_hidden = FALSE',
      `UPPER(COALESCE(t.category, '')) NOT IN (${NON_CASH_FLOW_CATEGORIES.map((c) => `'${c}'`).join(', ')})`,
    ];
    const params = [];
    let paramIndex = 1;

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

    if (accountId) {
      const parsedAccountId = parseInt(accountId, 10);
      if (isNaN(parsedAccountId)) {
        return res.status(400).json({ error: 'Invalid account_id parameter.' });
      }
      conditions.push(`t.account_id = $${paramIndex}`);
      params.push(parsedAccountId);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(`
      SELECT
        DATE_TRUNC('month', t.date) as month,
        SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)::numeric(15,2) as spending,
        SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END)::numeric(15,2) as income,
        CASE
          WHEN SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) > 0
          THEN ROUND(
            (SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) - SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END))
            / SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) * 100, 1
          )
          ELSE 0
        END as savings_rate
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      ${whereClause}
      GROUP BY DATE_TRUNC('month', t.date)
      ORDER BY month ASC
    `, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get income vs spending error');
    res.status(500).json({ error: 'Server error retrieving income vs spending' });
  }
});

// GET /api/analytics/investment-performance
router.get('/investment-performance', async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      account_id: accountId,
      benchmark = 'SPY',
    } = req.query;

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return res.status(400).json({ error: 'Dates must use YYYY-MM-DD format.' });
    }

    const parsedAccountId = accountId ? parseInt(accountId, 10) : null;
    if (accountId && isNaN(parsedAccountId)) {
      return res.status(400).json({ error: 'Invalid account_id parameter.' });
    }

    const result = await FinancialQueryService.analyzeInvestments({
      startDate,
      endDate,
      scopeType: parsedAccountId ? 'account' : 'portfolio',
      accountId: parsedAccountId,
      benchmarkSymbol: benchmark,
    });

    res.json({ data: result });
  } catch (error) {
    logger.error({ err: error }, 'Get investment performance error');
    res.status(500).json({ error: 'Server error retrieving investment performance' });
  }
});

// GET /api/analytics/benchmark-history
const BENCHMARK_SYMBOLS = ['SPY', 'QQQ'];

router.get('/benchmark-history', async (req, res) => {
  try {
    const { symbol, startDate, endDate } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: 'symbol parameter is required.' });
    }
    const normalizedSymbol = symbol.toUpperCase();
    if (!BENCHMARK_SYMBOLS.includes(normalizedSymbol)) {
      return res.status(400).json({ error: `Invalid symbol. Must be one of: ${BENCHMARK_SYMBOLS.join(', ')}.` });
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

// GET /api/analytics/spending-heatmap
router.get('/spending-heatmap', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const conditions = ['t.amount > 0', 't.pending = false', 'a.is_hidden = FALSE'];
    const params = [];
    let paramIndex = 1;

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

    const result = await pool.query(`
      SELECT
        t.date,
        SUM(t.amount)::numeric(15,2) as total,
        COUNT(*)::int as tx_count
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
      ${whereClause}
      GROUP BY t.date
      ORDER BY t.date ASC
    `, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get spending heatmap error');
    res.status(500).json({ error: 'Server error retrieving spending heatmap' });
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
