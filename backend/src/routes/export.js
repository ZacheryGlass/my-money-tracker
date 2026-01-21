const express = require('express');
const pool = require('../config/database');
const authenticateToken = require('../middleware/auth');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// Helper function to convert array to CSV
function arrayToCSV(data, headers) {
  if (!data || data.length === 0) return headers.join(',') + '\n';
  
  const csvRows = [headers.join(',')];
  
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header.toLowerCase().replace(/ /g, '_')];
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
        h.category,
        h.notes
      FROM holdings h
      JOIN accounts a ON h.account_id = a.id
      ORDER BY a.name, h.name
    `);

    const headers = ['account', 'ticker', 'name', 'quantity', 'category', 'notes'];
    const csv = arrayToCSV(result.rows, headers);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="holdings.csv"');
    res.status(200).send(csv);
  } catch (error) {
    console.error('Export holdings error:', error);
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
          snapshot_date,
          a.name as account_name,
          total_value
        FROM account_snapshots acs
        JOIN accounts a ON acs.account_id = a.id
        ORDER BY snapshot_date DESC, a.name
      `;
      headers = ['snapshot_date', 'account_name', 'total_value'];
      filename = 'account_history';
    } else if (type === 'portfolio') {
      query = `
        SELECT 
          snapshot_date,
          SUM(total_value) as total_value
        FROM account_snapshots
        GROUP BY snapshot_date
        ORDER BY snapshot_date DESC
      `;
      headers = ['snapshot_date', 'total_value'];
      filename = 'portfolio_history';
    } else {
      // Default to tickers
      query = `
        SELECT 
          snapshot_date,
          a.name as account_name,
          ticker,
          name,
          value
        FROM ticker_snapshots ts
        JOIN accounts a ON ts.account_id = a.id
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
    console.error('Export history error:', error);
    res.status(500).json({ error: 'Server error exporting history' });
  }
});

module.exports = router;
