'use strict';

const pool = require('../config/database');

class EthAddressLabel {
  // The user's own rows plus the shared builtins, with a user row shadowing
  // the builtin for the same address.
  //
  // Bulk seed packs (source 'eth-labels', migration 036) are deliberately left
  // out: this list is a management UI, and 5k scraped rows would bury the
  // handful of labels the user actually curated -- while shipping ~700KB down
  // the wire on every Settings load. They still classify, still shadow, and
  // still answer findByAddress; they just are not a to-do list.
  //
  // The bridge pack ('builtin-bridge', migration 044) IS listed, on the same
  // reasoning read the other way: it is a few dozen rows, each taken from its
  // protocol's own deployment docs, and a wrong one reclassifies a real send as
  // an internal transfer. That has to be visible to be correctable.
  // The small official protocol packs (for example 'builtin-polymarket',
  // migration 052) are listed for the same reason: a known protocol
  // counterparty needs to be visible and correctable.
  //
  // The filter sits OUTSIDE the DISTINCT ON so shadowing resolves first: a
  // user's override of a packed address wins precedence and stays in the list,
  // while an untouched pack row wins nothing and drops out. Today the predicate
  // only ever removes builtins, so filtering inside would give the same answer
  // -- keep it outside anyway. Narrowing the candidate set before precedence
  // resolves is exactly the trap that lets a builtin outrank a user's override
  // in reclassifyCounterparties, and the next predicate may not be so harmless.
  static async findAllForUser(userId) {
    const result = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (address) *
         FROM eth_address_labels
         WHERE user_id = $1 OR user_id IS NULL
         ORDER BY address, user_id NULLS LAST
       ) labels
       WHERE user_id IS NOT NULL OR source IN ('builtin', 'builtin-bridge', 'builtin-polymarket', 'builtin-etherdelta')
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
  // A NULL kind means "don't change the verdict" -- on the update arm it keeps
  // the user's stored kind, and on a fresh insert it INHERITS the builtin's
  // verdict when one exists, defaulting to 'exchange' only for an address
  // nobody has judged anywhere. This is load-bearing, not defensive: renaming
  // a label is a plain re-upsert with no kind, and a caller that predates the
  // column (or simply omits it) must NOT silently re-vote. Writing kind
  // outright would let a rename flip an 'own' address to 'exchange'; skipping
  // the builtin lookup did the same to pack 'external' gateways (CoinPayments,
  // MoonPay, ...) -- the fresh user row shadowed the pack row as 'exchange',
  // rewriting that spending as an internal transfer.
  static async upsert(userId, address, name, note, kind = null, exchangeAccountId = null) {
    const result = await pool.query(
      `INSERT INTO eth_address_labels (user_id, address, name, source, note, kind, exchange_account_id)
       VALUES ($1, $2::text, $3, 'user', $4,
               COALESCE($5,
                        (SELECT kind FROM eth_address_labels
                          WHERE address = $2::text AND user_id IS NULL),
                        'exchange'),
               $6)
       ON CONFLICT (user_id, address) WHERE user_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name,
                     kind = COALESCE($5, eth_address_labels.kind),
                     note = COALESCE(EXCLUDED.note, eth_address_labels.note),
                     exchange_account_id = CASE
                       WHEN $5::text = 'exchange' THEN $6::int
                       WHEN $5::text IS NOT NULL THEN NULL
                       ELSE eth_address_labels.exchange_account_id
                     END
       RETURNING *`,
      [userId, address.toLowerCase(), name, note || null, kind, exchangeAccountId]
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
