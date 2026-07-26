'use strict';

const pool = require('../config/database');

// The cross-chain half of the activity layer: which bridge_out on chain A is
// which bridge_in on chain B.
//
// Ownership lives on eth_wallets (the root table), so there is deliberately no
// user_id column here -- scope is inherited through eth_activity -> eth_wallets
// exactly like eth_transfers and eth_activity_overrides. A denormalized owner
// would be a second answer to "whose row is this", and the two can disagree.
//
// Every write below is delete-then-insert for the whole user. These rows are
// DERIVED (from amounts and timestamps), not corrections -- unlike
// eth_activity_overrides, which exists precisely because a rebuild must never
// erase a human's verdict.
class EthActivityLink {
  static async replaceForUser(userId, links) {
    if (!userId) throw new Error('EthActivityLink.replaceForUser requires a userId');

    // Joining out_activity_id alone is enough: both endpoints of a link belong
    // to the same owner (the matcher only ever pairs rows from one user's
    // query), and every link has an out side.
    await pool.query(
      `DELETE FROM eth_activity_links l
       USING eth_activity a, eth_wallets w
       WHERE l.out_activity_id = a.id AND a.wallet_id = w.id AND w.user_id = $1`,
      [userId]
    );
    if (!links.length) return 0;

    const values = [];
    const placeholders = links.map((link, i) => {
      const base = i * 6;
      values.push(
        link.out_activity_id,
        link.in_activity_id,
        link.asset,
        link.out_amount,
        link.in_amount,
        link.fee_amount
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    // No ON CONFLICT clause on purpose. Both endpoints carry a UNIQUE index, so
    // a collision here means the matcher claimed one leg twice -- a bug that
    // must surface, not a duplicate to swallow. Callers wrap the matching pass
    // the way they wrap every other derivation, so a throw degrades to a logged
    // warning rather than a failed sync.
    const result = await pool.query(
      `INSERT INTO eth_activity_links
         (out_activity_id, in_activity_id, asset, out_amount, in_amount, fee_amount)
       VALUES ${placeholders.join(', ')}`,
      values
    );
    return result.rowCount;
  }

  // Re-asserts the review flag on every bridge leg the user owns, both ways.
  //
  // Both directions are needed, and the unflagging one is not the interesting
  // half: eth_activity is rebuilt PER WALLET, so a resync of the wallet holding
  // the far side can orphan a leg that was matched a moment ago. Without the
  // re-flag it would keep presenting as a completed transfer with nothing on
  // the other end -- the one outcome an activity layer whose whole promise is
  // "no transaction unexplained" cannot afford.
  //
  // Returns the number of legs left unmatched (i.e. still flagged).
  static async syncBridgeReviewState(userId, reviewReason) {
    if (!userId) throw new Error('EthActivityLink.syncBridgeReviewState requires a userId');

    const matched = `EXISTS (SELECT 1 FROM eth_activity_links l
                             WHERE l.out_activity_id = a.id OR l.in_activity_id = a.id)`;

    await pool.query(
      `UPDATE eth_activity a
       SET needs_review = FALSE, review_reason = NULL, confidence = 'high'
       FROM eth_wallets w
       WHERE a.wallet_id = w.id AND w.user_id = $1
         AND a.category IN ('bridge_out', 'bridge_in')
         AND ${matched}`,
      [userId]
    );
    const result = await pool.query(
      `UPDATE eth_activity a
       SET needs_review = TRUE, review_reason = $2, confidence = 'medium'
       FROM eth_wallets w
       WHERE a.wallet_id = w.id AND w.user_id = $1
         AND a.category IN ('bridge_out', 'bridge_in')
         AND NOT ${matched}`,
      [userId, reviewReason]
    );
    return result.rowCount;
  }
}

module.exports = EthActivityLink;
