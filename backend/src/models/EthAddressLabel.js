'use strict';

const pool = require('../config/database');

class EthAddressLabel {
  // The user's own rows plus the shared builtins, with a user row shadowing
  // the builtin for the same address.
  static async findAllForUser(userId) {
    const result = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (address) *
         FROM eth_address_labels
         WHERE user_id = $1 OR user_id IS NULL
         ORDER BY address, user_id NULLS LAST
       ) labels
       ORDER BY name, address`,
      [userId]
    );
    return result.rows;
  }

  static async findByAddress(userId, address) {
    const result = await pool.query(
      `SELECT * FROM eth_address_labels
       WHERE address = $1 AND (user_id = $2 OR user_id IS NULL)
       ORDER BY user_id NULLS LAST
       LIMIT 1`,
      [address.toLowerCase(), userId]
    );
    return result.rows[0] || null;
  }

  // A user's label is a separate row from any builtin for the same address
  // (the builtin keeps user_id NULL); reads shadow builtins with user rows.
  //
  // A NULL kind means "don't change the verdict" -- it defaults to 'exchange'
  // only when inserting a brand-new row. This is load-bearing, not defensive:
  // renaming a label is a plain re-upsert with no kind, and a caller that
  // predates the column (or simply omits it) must NOT silently re-vote. Writing
  // kind outright would let renaming an 'own' address flip it to 'exchange',
  // dropping it out of the own set and turning a self-transfer into a phantom
  // exchange deposit -- real spending erased from cash flow.
  static async upsert(userId, address, name, note, kind = null) {
    const result = await pool.query(
      `INSERT INTO eth_address_labels (user_id, address, name, source, note, kind)
       VALUES ($1, $2, $3, 'user', $4, COALESCE($5, 'exchange'))
       ON CONFLICT (user_id, address) WHERE user_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name,
                     kind = COALESCE($5, eth_address_labels.kind),
                     note = COALESCE(EXCLUDED.note, eth_address_labels.note)
       RETURNING *`,
      [userId, address.toLowerCase(), name, note || null, kind]
    );
    return result.rows[0];
  }

  // Builtins (user_id NULL) are not deletable: removing the row would only
  // resurrect it on the next boot when the seed re-runs. Callers 409 instead.
  static async delete(userId, address) {
    const result = await pool.query(
      `DELETE FROM eth_address_labels
       WHERE user_id = $1 AND address = $2
       RETURNING *`,
      [userId, address.toLowerCase()]
    );
    return result.rows[0] || null;
  }
}

module.exports = EthAddressLabel;
