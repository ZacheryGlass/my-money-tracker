'use strict';

const express = require('express');
const pool = require('../config/database');
const authenticateToken = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

router.use(authenticateToken);

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

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (year) {
      const parsedYear = parseInt(year);
      if (isNaN(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
        return res.status(400).json({ error: 'Invalid year parameter.' });
      }
      conditions.push(`snapshot_date >= $${paramIndex}`);
      params.push(`${parsedYear}-01-01`);
      paramIndex++;
      conditions.push(`snapshot_date <= $${paramIndex}`);
      params.push(`${parsedYear}-12-31`);
      paramIndex++;
    }

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`snapshot_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`snapshot_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      WITH daily_totals AS (
        SELECT snapshot_date, SUM(total_value) as total_value
        FROM account_snapshots
        ${whereClause}
        GROUP BY snapshot_date
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

    const conditions = ['amount > 0', 'pending = false'];
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const truncExpr = groupBy === 'month' ? "DATE_TRUNC('month', date)" : "DATE_TRUNC('week', date)";

    const result = await pool.query(`
      SELECT
        ${truncExpr} as period,
        COALESCE(category, 'Uncategorized') as category,
        SUM(amount)::numeric(15,2) as total,
        COUNT(*)::int as tx_count
      FROM transactions
      ${whereClause}
      GROUP BY ${truncExpr}, COALESCE(category, 'Uncategorized')
      ORDER BY period DESC, total DESC
    `, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get spending by category error');
    res.status(500).json({ error: 'Server error retrieving spending by category' });
  }
});

// GET /api/analytics/income-vs-spending
router.get('/income-vs-spending', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const conditions = ['pending = false'];
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(`
      SELECT
        DATE_TRUNC('month', date) as month,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::numeric(15,2) as spending,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::numeric(15,2) as income,
        CASE
          WHEN SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) > 0
          THEN ROUND(
            (SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) - SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END))
            / SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) * 100, 1
          )
          ELSE 0
        END as savings_rate
      FROM transactions
      ${whereClause}
      GROUP BY DATE_TRUNC('month', date)
      ORDER BY month ASC
    `, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get income vs spending error');
    res.status(500).json({ error: 'Server error retrieving income vs spending' });
  }
});

// GET /api/analytics/spending-heatmap
router.get('/spending-heatmap', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const conditions = ['amount > 0', 'pending = false'];
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await pool.query(`
      SELECT
        date,
        SUM(amount)::numeric(15,2) as total,
        COUNT(*)::int as tx_count
      FROM transactions
      ${whereClause}
      GROUP BY date
      ORDER BY date ASC
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
        COALESCE(merchant_name, name) as merchant,
        ROUND(AVG(amount)::numeric, 2) as avg_amount,
        COUNT(*)::int as occurrence_count,
        MAX(date) as last_charge,
        MIN(date) as first_charge,
        (ARRAY_AGG(category ORDER BY date DESC))[1] as category
      FROM transactions
      WHERE amount > 0 AND pending = false
      GROUP BY COALESCE(merchant_name, name)
      HAVING COUNT(*) >= 3
         AND STDDEV(amount) < 5
         AND (MAX(date) - MIN(date)) > 60
      ORDER BY ROUND(AVG(amount)::numeric, 2) DESC
    `);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get detected subscriptions error');
    res.status(500).json({ error: 'Server error detecting subscriptions' });
  }
});

module.exports = router;
