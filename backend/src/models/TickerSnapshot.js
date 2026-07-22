const pool = require('../config/database');

class TickerSnapshot {
  static async bulkCreate(snapshots) {
    if (snapshots.length === 0) {
      return [];
    }

    const withTicker = snapshots.filter(s => s.ticker != null);
    const withoutTicker = snapshots.filter(s => s.ticker == null);
    const results = [];

    if (withTicker.length > 0) {
      const values = [];
      const placeholders = [];
      let paramIndex = 1;
      for (const snapshot of withTicker) {
        placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`);
        values.push(
          snapshot.snapshotDate, snapshot.accountId, snapshot.ticker, snapshot.name,
          snapshot.value, snapshot.quantity ?? null, snapshot.price ?? null
        );
        paramIndex += 7;
      }
      const result = await pool.query(
        `INSERT INTO ticker_snapshots (snapshot_date, account_id, ticker, name, value, quantity, price_usd)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (snapshot_date, account_id, ticker) WHERE ticker IS NOT NULL
         DO UPDATE SET value = EXCLUDED.value, name = EXCLUDED.name,
                       quantity = EXCLUDED.quantity, price_usd = EXCLUDED.price_usd
         RETURNING *`,
        values
      );
      results.push(...result.rows);
    }

    if (withoutTicker.length > 0) {
      const values = [];
      const placeholders = [];
      let paramIndex = 1;
      for (const snapshot of withoutTicker) {
        placeholders.push(`($${paramIndex}, $${paramIndex + 1}, NULL, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
        values.push(
          snapshot.snapshotDate, snapshot.accountId, snapshot.name, snapshot.value,
          snapshot.quantity ?? null, snapshot.price ?? null
        );
        paramIndex += 6;
      }
      const result = await pool.query(
        `INSERT INTO ticker_snapshots (snapshot_date, account_id, ticker, name, value, quantity, price_usd)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (snapshot_date, account_id, name) WHERE ticker IS NULL
         DO UPDATE SET value = EXCLUDED.value,
                       quantity = EXCLUDED.quantity, price_usd = EXCLUDED.price_usd
         RETURNING *`,
        values
      );
      results.push(...result.rows);
    }

    return results;
  }

  static async findByDate(snapshotDate) {
    const result = await pool.query(
      'SELECT * FROM ticker_snapshots WHERE snapshot_date = $1 ORDER BY account_id, ticker',
      [snapshotDate]
    );
    return result.rows;
  }

  static async existsForDate(snapshotDate) {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM ticker_snapshots WHERE snapshot_date = $1',
      [snapshotDate]
    );
    return parseInt(result.rows[0].count) > 0;
  }
}

module.exports = TickerSnapshot;
