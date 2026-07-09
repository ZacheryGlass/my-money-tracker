'use strict';

const express = require('express');
const pool = require('../config/database');
const authenticateToken = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// Helper function to validate date format (YYYY-MM-DD)
function isValidDate(dateString) {
  if (!dateString) return true; // Allow undefined/null
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

// GET /api/history/tickers - List all ticker snapshots with filtering and pagination
router.get('/tickers', async (req, res) => {
  try {
    const {
      ticker,
      account_id,
      startDate,
      endDate,
      limit = 30,
      offset = 0
    } = req.query;

    // Validate pagination parameters
    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);

    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 10000.' });
    }

    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    // Build the WHERE clause dynamically based on filters
    const conditions = ['a.is_hidden = FALSE'];
    const params = [];
    let paramIndex = 1;

    if (ticker) {
      conditions.push(`ts.ticker = $${paramIndex}`);
      params.push(ticker);
      paramIndex++;
    }

    if (account_id) {
      const parsedAccountId = parseInt(account_id);
      if (isNaN(parsedAccountId)) {
        return res.status(400).json({ error: 'Invalid account_id parameter. Must be a number.' });
      }
      conditions.push(`ts.account_id = $${paramIndex}`);
      params.push(parsedAccountId);
      paramIndex++;
    }

    if (startDate) {
      if (!isValidDate(startDate)) {
        return res.status(400).json({ error: 'Invalid startDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`ts.snapshot_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      if (!isValidDate(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate format. Must be YYYY-MM-DD.' });
      }
      conditions.push(`ts.snapshot_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM ticker_snapshots ts
      JOIN accounts a ON ts.account_id = a.id
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const dataQuery = (!startDate && !endDate)
      ? `
        WITH recent AS (
          SELECT
            ts.snapshot_date,
            ts.account_id,
            ts.ticker,
            ts.name,
            ts.value
          FROM ticker_snapshots ts
          JOIN accounts a ON ts.account_id = a.id
          ${whereClause}
          ORDER BY ts.snapshot_date DESC, ts.id DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        )
        SELECT * FROM recent
        ORDER BY snapshot_date ASC, account_id ASC, ticker ASC
      `
      : `
        SELECT
          ts.snapshot_date,
          ts.account_id,
          ts.ticker,
          ts.name,
          ts.value
        FROM ticker_snapshots ts
        JOIN accounts a ON ts.account_id = a.id
        ${whereClause}
        ORDER BY ts.snapshot_date ASC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

    const dataParams = [...params, parsedLimit, parsedOffset];
    const dataResult = await pool.query(dataQuery, dataParams);

    res.status(200).json({
      data: dataResult.rows,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Get ticker history error');
    res.status(500).json({ error: 'Server error retrieving ticker history' });
  }
});

// GET /api/history/accounts - List account snapshots with filtering and pagination
router.get('/accounts', async (req, res) => {
  try {
    const {
      account_id,
      startDate,
      endDate,
      limit = 30,
      offset = 0
    } = req.query;

    // Validate pagination parameters
    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);

    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 10000.' });
    }

    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    // Build the WHERE clause dynamically based on filters
    const conditions = ['a.is_hidden = FALSE'];
    const params = [];
    let paramIndex = 1;

    if (account_id) {
      const parsedAccountId = parseInt(account_id);
      if (isNaN(parsedAccountId)) {
        return res.status(400).json({ error: 'Invalid account_id parameter. Must be a number.' });
      }
      conditions.push(`acs.account_id = $${paramIndex}`);
      params.push(parsedAccountId);
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

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM account_snapshots acs
      JOIN accounts a ON acs.account_id = a.id
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const dataQuery = (!startDate && !endDate)
      ? `
        WITH recent AS (
          SELECT
            acs.snapshot_date,
            acs.account_id,
            acs.total_value
          FROM account_snapshots acs
          JOIN accounts a ON acs.account_id = a.id
          ${whereClause}
          ORDER BY acs.snapshot_date DESC, acs.account_id ASC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        )
        SELECT * FROM recent
        ORDER BY snapshot_date ASC, account_id ASC
      `
      : `
        SELECT
          acs.snapshot_date,
          acs.account_id,
          acs.total_value
        FROM account_snapshots acs
        JOIN accounts a ON acs.account_id = a.id
        ${whereClause}
        ORDER BY acs.snapshot_date ASC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

    const dataParams = [...params, parsedLimit, parsedOffset];
    const dataResult = await pool.query(dataQuery, dataParams);

    res.status(200).json({
      data: dataResult.rows,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Get account history error');
    res.status(500).json({ error: 'Server error retrieving account history' });
  }
});

// GET /api/history/portfolio - Get total portfolio value over time
router.get('/portfolio', async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      limit = 30,
      offset = 0
    } = req.query;

    // Validate pagination parameters
    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);

    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 10000) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 10000.' });
    }

    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    // Build the WHERE clause dynamically based on filters
    const conditions = ['a.is_hidden = FALSE'];
    const params = [];
    let paramIndex = 1;

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

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(DISTINCT acs.snapshot_date) as total
      FROM account_snapshots acs
      JOIN accounts a ON acs.account_id = a.id
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    const dataQuery = (!startDate && !endDate)
      ? `
        WITH daily_totals AS (
          SELECT
            acs.snapshot_date,
            SUM(acs.total_value) as total_value
          FROM account_snapshots acs
          JOIN accounts a ON acs.account_id = a.id
          ${whereClause}
          GROUP BY acs.snapshot_date
          ORDER BY acs.snapshot_date DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        )
        SELECT * FROM daily_totals
        ORDER BY snapshot_date ASC
      `
      : `
        SELECT
          acs.snapshot_date,
          SUM(acs.total_value) as total_value
        FROM account_snapshots acs
        JOIN accounts a ON acs.account_id = a.id
        ${whereClause}
        GROUP BY acs.snapshot_date
        ORDER BY acs.snapshot_date ASC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

    const dataParams = [...params, parsedLimit, parsedOffset];
    const dataResult = await pool.query(dataQuery, dataParams);

    res.status(200).json({
      data: dataResult.rows,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Get portfolio history error');
    res.status(500).json({ error: 'Server error retrieving portfolio history' });
  }
});

module.exports = router;
