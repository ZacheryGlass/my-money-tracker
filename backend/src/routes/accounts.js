'use strict';

const express = require('express');
const pool = require('../config/database');
const authenticateToken = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// GET /api/accounts - List all accounts with holdings count
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.type, a.plaid_item_id,
              COUNT(h.id)::int AS holdings_count
       FROM accounts a
       LEFT JOIN holdings h ON h.account_id = a.id
       GROUP BY a.id
       ORDER BY a.type DESC, a.name ASC`
    );
    res.status(200).json({ accounts: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get accounts error');
    res.status(500).json({ error: 'Server error retrieving accounts' });
  }
});

// DELETE /api/accounts/:id - Delete an account and all its data
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id);
    const account = await client.query('SELECT id, name, plaid_item_id FROM accounts WHERE id = $1', [id]);
    if (account.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    if (account.rows[0].plaid_item_id) {
      return res.status(400).json({ error: 'Cannot delete a Plaid-linked account. Disconnect the Plaid connection first.' });
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM ticker_snapshots WHERE account_id = $1', [id]);
    await client.query('DELETE FROM account_snapshots WHERE account_id = $1', [id]);
    await client.query('DELETE FROM holdings WHERE account_id = $1', [id]);
    await client.query('DELETE FROM accounts WHERE id = $1', [id]);
    await client.query('COMMIT');

    logger.info({ accountId: id, accountName: account.rows[0].name }, 'Account deleted');
    res.status(200).json({ message: `Account "${account.rows[0].name}" deleted successfully` });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ err: error }, 'Delete account error');
    res.status(500).json({ error: 'Server error deleting account' });
  } finally {
    client.release();
  }
});

// POST /api/accounts/migrate - Migrate snapshots from source to target, then delete source
router.post('/migrate', async (req, res) => {
  const client = await pool.connect();
  try {
    const { sourceAccountId, targetAccountId } = req.body;
    if (!sourceAccountId || !targetAccountId) {
      return res.status(400).json({ error: 'sourceAccountId and targetAccountId are required' });
    }
    if (sourceAccountId === targetAccountId) {
      return res.status(400).json({ error: 'Source and target accounts must be different' });
    }

    const [source, target] = await Promise.all([
      client.query('SELECT id, name FROM accounts WHERE id = $1', [sourceAccountId]),
      client.query('SELECT id, name FROM accounts WHERE id = $1', [targetAccountId]),
    ]);
    if (source.rows.length === 0) return res.status(404).json({ error: 'Source account not found' });
    if (target.rows.length === 0) return res.status(404).json({ error: 'Target account not found' });

    await client.query('BEGIN');

    // Delete target ticker_snapshots that conflict with source dates+tickers
    await client.query(
      `DELETE FROM ticker_snapshots WHERE account_id = $1
       AND (snapshot_date, ticker) IN (
         SELECT snapshot_date, ticker FROM ticker_snapshots WHERE account_id = $2
       )`,
      [targetAccountId, sourceAccountId]
    );

    // Delete target account_snapshots that conflict with source dates
    await client.query(
      `DELETE FROM account_snapshots WHERE account_id = $1
       AND snapshot_date IN (
         SELECT snapshot_date FROM account_snapshots WHERE account_id = $2
       )`,
      [targetAccountId, sourceAccountId]
    );

    // Reassign source snapshots to target
    const [tickerResult, accountResult] = await Promise.all([
      client.query('UPDATE ticker_snapshots SET account_id = $1 WHERE account_id = $2', [targetAccountId, sourceAccountId]),
      client.query('UPDATE account_snapshots SET account_id = $1 WHERE account_id = $2', [targetAccountId, sourceAccountId]),
    ]);

    // Delete source account (CASCADE removes its holdings)
    await client.query('DELETE FROM accounts WHERE id = $1', [sourceAccountId]);

    await client.query('COMMIT');

    logger.info(
      { sourceAccountId, targetAccountId, tickerSnapshots: tickerResult.rowCount, accountSnapshots: accountResult.rowCount },
      'Account migration completed'
    );

    res.status(200).json({
      message: `Migrated "${source.rows[0].name}" into "${target.rows[0].name}"`,
      tickerSnapshotsMigrated: tickerResult.rowCount,
      accountSnapshotsMigrated: accountResult.rowCount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ err: error }, 'Account migration error');
    res.status(500).json({ error: 'Migration failed: ' + error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
