const pool = require('../config/database');

class TickerSnapshot {
  static async create(snapshotDate, accountId, ticker, name, value) {
    const result = await pool.query(
      'INSERT INTO ticker_snapshots (snapshot_date, account_id, ticker, name, value) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [snapshotDate, accountId, ticker, name, value]
    );
    return result.rows[0];
  }

  static async bulkCreate(snapshots) {
    if (snapshots.length === 0) {
      return [];
    }

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const snapshot of snapshots) {
      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4})`);
      values.push(snapshot.snapshotDate, snapshot.accountId, snapshot.ticker, snapshot.name, snapshot.value);
      paramIndex += 5;
    }

    const query = `
      INSERT INTO ticker_snapshots (snapshot_date, account_id, ticker, name, value)
      VALUES ${placeholders.join(', ')}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    return result.rows;
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
