'use strict';

const express = require('express');
const pool = require('../config/database');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

// Apply auth middleware to all routes
router.use(requireUser);

// Helper function to convert array to CSV
function arrayToCSV(data, headers) {
  if (!data || data.length === 0) return headers.join(',') + '\n';

  const csvRows = [headers.join(',')];

  for (const row of data) {
    const values = headers.map(header => {
      // Use the header as-is since database columns match expected headers
      const value = row[header];
      // Escape values that contain commas or quotes
      if (value === null || value === undefined) return '';
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

// GET /api/export/holdings - Export all holdings as CSV
router.get('/holdings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.name as account,
        h.ticker,
        h.name,
        h.quantity,
        h.manual_value,
        h.category,
        h.location,
        h.notes
      FROM holdings h
      JOIN accounts a ON h.account_id = a.id
      WHERE a.is_hidden = FALSE
      ORDER BY a.name, h.name
    `);

    const headers = ['account', 'ticker', 'name', 'quantity', 'manual_value', 'category', 'location', 'notes'];
    const csv = arrayToCSV(result.rows, headers);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="holdings.csv"');
    res.status(200).send(csv);
  } catch (error) {
    logger.error({ err: error }, 'Export holdings error');
    res.status(500).json({ error: 'Server error exporting holdings' });
  }
});

// GET /api/export/history - Export history data
router.get('/history', async (req, res) => {
  try {
    const { type = 'tickers', format = 'csv' } = req.query;

    let query;
    let headers;
    let filename;

    if (type === 'accounts') {
      query = `
        SELECT
          acs.snapshot_date,
          a.name as account_name,
          acs.total_value
        FROM account_snapshots acs
        JOIN accounts a ON acs.account_id = a.id
        WHERE a.is_hidden = FALSE
        ORDER BY snapshot_date DESC, a.name
      `;
      headers = ['snapshot_date', 'account_name', 'total_value'];
      filename = 'account_history';
    } else if (type === 'portfolio') {
      query = `
        SELECT
          acs.snapshot_date,
          SUM(acs.total_value) as total_value
        FROM account_snapshots acs
        JOIN accounts a ON acs.account_id = a.id
        WHERE a.is_hidden = FALSE
        GROUP BY acs.snapshot_date
        ORDER BY acs.snapshot_date DESC
      `;
      headers = ['snapshot_date', 'total_value'];
      filename = 'portfolio_history';
    } else {
      // Default to tickers
      query = `
        SELECT
          ts.snapshot_date,
          a.name as account_name,
          ts.ticker,
          ts.name,
          ts.value
        FROM ticker_snapshots ts
        JOIN accounts a ON ts.account_id = a.id
        WHERE a.is_hidden = FALSE
        ORDER BY snapshot_date DESC, a.name, ticker
      `;
      headers = ['snapshot_date', 'account_name', 'ticker', 'name', 'value'];
      filename = 'ticker_history';
    }

    const result = await pool.query(query);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      res.status(200).json(result.rows);
    } else {
      // Default to CSV
      const csv = arrayToCSV(result.rows, headers);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.status(200).send(csv);
    }
  } catch (error) {
    logger.error({ err: error }, 'Export history error');
    res.status(500).json({ error: 'Server error exporting history' });
  }
});

module.exports = router;
