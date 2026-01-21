const express = require('express');
const Holding = require('../models/Holding');
const authenticateToken = require('../middleware/auth');
const { validateHolding } = require('../middleware/validator');
const pool = require('../config/database');
const csvParser = require('csv-parser');
const { Readable } = require('stream');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// GET /api/holdings - List all holdings
router.get('/', async (req, res) => {
  try {
    const holdings = await Holding.findAll();
    res.status(200).json({ holdings });
  } catch (error) {
    console.error('Get holdings error:', error);
    res.status(500).json({ error: 'Server error retrieving holdings' });
  }
});

// GET /api/holdings/:id - Get single holding
router.get('/:id', async (req, res) => {
  try {
    const holding = await Holding.findById(parseInt(req.params.id));
    if (!holding) {
      return res.status(404).json({ error: 'Holding not found' });
    }
    res.status(200).json({ holding });
  } catch (error) {
    console.error('Get holding error:', error);
    res.status(500).json({ error: 'Server error retrieving holding' });
  }
});

// POST /api/holdings - Create new holding
router.post('/', validateHolding, async (req, res) => {
  try {
    const { account_id, ticker, name, quantity, manual_value, category, notes } = req.body;

    const holding = await Holding.create(
      account_id,
      ticker,
      name,
      quantity || null,
      manual_value || null,
      category || null,
      notes || null
    );

    res.status(201).json({ holding });
  } catch (error) {
    console.error('Create holding error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This holding already exists for this account' });
    }
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Referenced account does not exist' });
    }
    res.status(500).json({ error: 'Server error creating holding' });
  }
});

// PUT /api/holdings/:id - Update holding
router.put('/:id', validateHolding, async (req, res) => {
  try {
    const { account_id, ticker, name, quantity, manual_value, category, notes } = req.body;
    const id = parseInt(req.params.id);

    // Check if holding exists
    const existing = await Holding.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    const holding = await Holding.update(
      id,
      account_id,
      ticker,
      name,
      quantity || null,
      manual_value || null,
      category || null,
      notes || null
    );

    res.status(200).json({ holding });
  } catch (error) {
    console.error('Update holding error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This holding already exists for this account' });
    }
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Referenced account does not exist' });
    }
    res.status(500).json({ error: 'Server error updating holding' });
  }
});

// DELETE /api/holdings/:id - Delete holding
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Check if holding exists
    const existing = await Holding.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    const result = await Holding.delete(id);
    res.status(200).json({ message: 'Holding deleted successfully', holding: result });
  } catch (error) {
    console.error('Delete holding error:', error);
    res.status(500).json({ error: 'Server error deleting holding' });
  }
});

// POST /api/holdings/bulk-import - Bulk import holdings from CSV
router.post('/bulk-import', express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
  try {
    const csvData = req.body;
    
    if (!csvData || csvData.trim() === '') {
      return res.status(400).json({ error: 'No CSV data provided' });
    }

    // Get all accounts for mapping
    const accountsResult = await pool.query('SELECT id, name FROM accounts');
    const accountsMap = new Map(accountsResult.rows.map(a => [a.name.toLowerCase(), a.id]));

    // Parse CSV
    const rows = [];
    const errors = [];
    const stream = Readable.from([csvData]);

    await new Promise((resolve, reject) => {
      stream
        .pipe(csvParser())
        .on('data', (row) => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty or invalid' });
    }

    // Validate and prepare data
    const validatedRows = [];
    const duplicates = [];

    // First, validate all rows
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // Account for header row

      // Validate required fields
      if (!row.account || !row.name) {
        errors.push({
          row: rowNum,
          error: 'Missing required fields: account and name are required',
          data: row
        });
        continue;
      }

      // Map account name to ID
      const accountId = accountsMap.get(row.account.toLowerCase().trim());
      if (!accountId) {
        errors.push({
          row: rowNum,
          error: `Account '${row.account}' not found`,
          data: row
        });
        continue;
      }

      // Validate numeric fields
      const quantity = row.quantity ? parseFloat(row.quantity) : null;
      if (row.quantity && isNaN(quantity)) {
        errors.push({
          row: rowNum,
          error: 'Invalid quantity value',
          data: row
        });
        continue;
      }

      validatedRows.push({
        rowNum,
        account_id: accountId,
        account_name: row.account.trim(),
        ticker: row.ticker ? row.ticker.trim() : null,
        name: row.name.trim(),
        quantity: quantity,
        category: row.category ? row.category.trim() : null
      });
    }

    // Batch check for duplicates
    if (validatedRows.length > 0) {
      const duplicateCheckQuery = validatedRows.map((row, index) => {
        return `SELECT $${index * 3 + 1} as account_id, $${index * 3 + 2} as name, $${index * 3 + 3} as ticker, id FROM holdings WHERE account_id = $${index * 3 + 1} AND name = $${index * 3 + 2} AND (ticker = $${index * 3 + 3} OR (ticker IS NULL AND $${index * 3 + 3} IS NULL))`;
      }).join(' UNION ALL ');

      const params = validatedRows.flatMap(row => [row.account_id, row.name, row.ticker]);
      
      try {
        const duplicateResult = await pool.query(duplicateCheckQuery, params);
        const duplicateMap = new Map();
        duplicateResult.rows.forEach(row => {
          const key = `${row.account_id}-${row.name}-${row.ticker}`;
          duplicateMap.set(key, row.id);
        });

        // Separate duplicates from valid rows
        const finalValidRows = [];
        for (const row of validatedRows) {
          const key = `${row.account_id}-${row.name}-${row.ticker}`;
          const existingId = duplicateMap.get(key);
          
          if (existingId) {
            duplicates.push({
              row: row.rowNum,
              existing_id: existingId,
              data: {
                account_id: row.account_id,
                account_name: row.account_name,
                ticker: row.ticker,
                name: row.name,
                quantity: row.quantity,
                category: row.category
              }
            });
          } else {
            finalValidRows.push({
              account_id: row.account_id,
              account_name: row.account_name,
              ticker: row.ticker,
              name: row.name,
              quantity: row.quantity,
              category: row.category
            });
          }
        }

        // Return preview with validation results
        res.status(200).json({
          preview: {
            total: rows.length,
            valid: finalValidRows.length,
            duplicates: duplicates.length,
            errors: errors.length
          },
          validRows: finalValidRows,
          duplicates: duplicates,
          errors: errors
        });
      } catch (error) {
        console.error('Duplicate check error:', error);
        // Fallback to individual checks if batch query fails
        const finalValidRows = [];
        for (const row of validatedRows) {
          const checkDuplicate = await pool.query(
            'SELECT id FROM holdings WHERE account_id = $1 AND name = $2 AND (ticker = $3 OR (ticker IS NULL AND $3 IS NULL))',
            [row.account_id, row.name, row.ticker]
          );

          if (checkDuplicate.rows.length > 0) {
            duplicates.push({
              row: row.rowNum,
              existing_id: checkDuplicate.rows[0].id,
              data: {
                account_id: row.account_id,
                account_name: row.account_name,
                ticker: row.ticker,
                name: row.name,
                quantity: row.quantity,
                category: row.category
              }
            });
          } else {
            finalValidRows.push({
              account_id: row.account_id,
              account_name: row.account_name,
              ticker: row.ticker,
              name: row.name,
              quantity: row.quantity,
              category: row.category
            });
          }
        }

        // Return preview with validation results
        res.status(200).json({
          preview: {
            total: rows.length,
            valid: finalValidRows.length,
            duplicates: duplicates.length,
            errors: errors.length
          },
          validRows: finalValidRows,
          duplicates: duplicates,
          errors: errors
        });
      }
    } else {
      // No valid rows
      res.status(200).json({
        preview: {
          total: rows.length,
          valid: 0,
          duplicates: 0,
          errors: errors.length
        },
        validRows: [],
        duplicates: [],
        errors: errors
      });
    }
  } catch (error) {
    console.error('Bulk import error:', error);
    res.status(500).json({ error: 'Server error processing CSV file' });
  }
});

// POST /api/holdings/bulk-import/confirm - Confirm and execute bulk import
router.post('/bulk-import/confirm', express.json(), async (req, res) => {
  try {
    const { rows, skipDuplicates } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided for import' });
    }

    const imported = [];
    const failed = [];

    for (const row of rows) {
      try {
        const holding = await Holding.create(
          row.account_id,
          row.ticker,
          row.name,
          row.quantity,
          null, // manual_value
          row.category,
          null  // notes
        );
        imported.push(holding);
      } catch (error) {
        if (error.code === '23505' && skipDuplicates) {
          // Skip duplicate
          continue;
        }
        failed.push({
          data: row,
          error: error.message
        });
      }
    }

    res.status(201).json({
      summary: {
        imported: imported.length,
        failed: failed.length
      },
      imported: imported,
      failed: failed
    });
  } catch (error) {
    console.error('Bulk import confirm error:', error);
    res.status(500).json({ error: 'Server error importing holdings' });
  }
});

module.exports = router;
