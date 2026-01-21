const express = require('express');
const pool = require('../config/database');
const authenticateToken = require('../middleware/auth');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

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
    
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 100.' });
    }
    
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    // Build the WHERE clause dynamically based on filters
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (ticker) {
      conditions.push(`ticker = $${paramIndex}`);
      params.push(ticker);
      paramIndex++;
    }

    if (account_id) {
      const parsedAccountId = parseInt(account_id);
      if (isNaN(parsedAccountId)) {
        return res.status(400).json({ error: 'Invalid account_id parameter. Must be a number.' });
      }
      conditions.push(`account_id = $${paramIndex}`);
      params.push(parsedAccountId);
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`snapshot_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`snapshot_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM ticker_snapshots ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get paginated data
    const dataQuery = `
      SELECT 
        snapshot_date,
        account_id,
        ticker,
        name,
        value
      FROM ticker_snapshots
      ${whereClause}
      ORDER BY snapshot_date ASC
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
    console.error('Get ticker history error:', error);
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
    
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 100.' });
    }
    
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    // Build the WHERE clause dynamically based on filters
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (account_id) {
      const parsedAccountId = parseInt(account_id);
      if (isNaN(parsedAccountId)) {
        return res.status(400).json({ error: 'Invalid account_id parameter. Must be a number.' });
      }
      conditions.push(`account_id = $${paramIndex}`);
      params.push(parsedAccountId);
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`snapshot_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`snapshot_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM account_snapshots ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get paginated data
    const dataQuery = `
      SELECT 
        snapshot_date,
        account_id,
        total_value
      FROM account_snapshots
      ${whereClause}
      ORDER BY snapshot_date ASC
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
    console.error('Get account history error:', error);
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
    
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be between 1 and 100.' });
    }
    
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      return res.status(400).json({ error: 'Invalid offset parameter. Must be a non-negative number.' });
    }

    // Build the WHERE clause dynamically based on filters
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (startDate) {
      conditions.push(`snapshot_date >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`snapshot_date <= $${paramIndex}`);
      params.push(endDate);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(DISTINCT snapshot_date) as total 
      FROM account_snapshots 
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get aggregated portfolio data
    const dataQuery = `
      SELECT 
        snapshot_date,
        SUM(total_value) as total_value
      FROM account_snapshots
      ${whereClause}
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC
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
    console.error('Get portfolio history error:', error);
    res.status(500).json({ error: 'Server error retrieving portfolio history' });
  }
});

module.exports = router;
