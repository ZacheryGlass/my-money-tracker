'use strict';

const express = require('express');
const pool = require('../config/database');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

// Apply auth middleware to all routes
router.use(requireUser);

const VALID_ACCOUNT_TYPES = ['investment', 'depository', 'credit', 'loan', 'crypto', 'property', 'other'];
const EFFECTIVE_ACCOUNT_NAME_SQL = "COALESCE(NULLIF(TRIM(a.display_name), ''), a.name)";
const ACCOUNT_RETURN_SELECT = `a.id, a.name, a.display_name,
                 ${EFFECTIVE_ACCOUNT_NAME_SQL} AS effective_name,
                 a.is_hidden,
                 a.type, a.plaid_item_id`;

// POST /api/accounts - Create a new manual account
router.post('/', async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required' });
    }
    if (!VALID_ACCOUNT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_ACCOUNT_TYPES.join(', ')}` });
    }
    const result = await pool.query(
      'INSERT INTO accounts (name, type) VALUES ($1, $2) RETURNING *',
      [name.trim(), type]
    );
    res.status(201).json({ account: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An account with that name already exists' });
    }
    logger.error({ err: error }, 'Create account error');
    res.status(500).json({ error: 'Server error creating account' });
  }
});

// GET /api/accounts - List all accounts with holdings count
router.get('/', async (req, res) => {
  try {
    const includeHidden = req.query.include_hidden === 'true';
    const hiddenFilter = includeHidden ? '' : 'WHERE a.is_hidden = FALSE';
    const result = await pool.query(
      `SELECT ${ACCOUNT_RETURN_SELECT},
              COUNT(h.id)::int AS holdings_count
       FROM accounts a
       LEFT JOIN holdings h ON h.account_id = a.id
       ${hiddenFilter}
       GROUP BY a.id
       ORDER BY a.type DESC, effective_name ASC`
    );
    res.status(200).json({ accounts: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get accounts error');
    res.status(500).json({ error: 'Server error retrieving accounts' });
  }
});

// PATCH /api/accounts/:id/display-name - Set or clear an account display name
router.patch('/:id/display-name', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid account id' });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body, 'display_name')) {
      return res.status(400).json({ error: 'display_name is required' });
    }

    const { display_name: displayName } = req.body;
    if (displayName !== null && typeof displayName !== 'string') {
      return res.status(400).json({ error: 'display_name must be a string or null' });
    }

    const normalizedName = displayName === null ? null : displayName.trim() || null;
    if (normalizedName && normalizedName.length > 100) {
      return res.status(400).json({ error: 'display_name must be 100 characters or fewer' });
    }

    const result = await pool.query(
      `UPDATE accounts a
       SET display_name = $1
       WHERE a.id = $2
       RETURNING ${ACCOUNT_RETURN_SELECT}`,
      [normalizedName, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.status(200).json({ account: result.rows[0] });
  } catch (error) {
    logger.error({ err: error }, 'Update account display name error');
    res.status(500).json({ error: 'Server error updating account display name' });
  }
});

// PATCH /api/accounts/:id/visibility - Hide or show an account in UI data
router.patch('/:id/visibility', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid account id' });
    }

    if (typeof req.body.is_hidden !== 'boolean') {
      return res.status(400).json({ error: 'is_hidden must be a boolean' });
    }

    const result = await pool.query(
      `UPDATE accounts a
       SET is_hidden = $1
       WHERE a.id = $2
       RETURNING ${ACCOUNT_RETURN_SELECT}`,
      [req.body.is_hidden, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.status(200).json({ account: result.rows[0] });
  } catch (error) {
    logger.error({ err: error }, 'Update account visibility error');
    res.status(500).json({ error: 'Server error updating account visibility' });
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
    await client.query('DELETE FROM transactions WHERE account_id = $1', [id]);
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
