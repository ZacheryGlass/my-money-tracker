const pool = require('../config/database');

class AccountSnapshot {
  static async create(snapshotDate, accountId, totalValue) {
    const result = await pool.query(
      'INSERT INTO account_snapshots (snapshot_date, account_id, total_value) VALUES ($1, $2, $3) RETURNING *',
      [snapshotDate, accountId, totalValue]
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
      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2})`);
      values.push(snapshot.snapshotDate, snapshot.accountId, snapshot.totalValue);
      paramIndex += 3;
    }

    const query = `
      INSERT INTO account_snapshots (snapshot_date, account_id, total_value)
      VALUES ${placeholders.join(', ')}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async findByDate(snapshotDate) {
    const result = await pool.query(
      'SELECT * FROM account_snapshots WHERE snapshot_date = $1 ORDER BY account_id',
      [snapshotDate]
    );
    return result.rows;
  }

  static async existsForDate(snapshotDate) {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM account_snapshots WHERE snapshot_date = $1',
      [snapshotDate]
    );
    return parseInt(result.rows[0].count) > 0;
  }
}

module.exports = AccountSnapshot;
