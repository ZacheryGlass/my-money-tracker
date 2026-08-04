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
// Every write below is delete-then-insert for the whole user. Since migration
// 072 these rows are only a compatibility projection of durable bridge
// movements. The database trigger rejects a projection whose movement is not
// protocol-verified or user-confirmed.
class EthActivityLink {
  static async replaceForUser(userId, links, client = pool) {
    if (!userId) throw new Error('EthActivityLink.replaceForUser requires a userId');

    // Joining out_activity_id alone is enough: both endpoints of a link belong
    // to the same owner (the matcher only ever pairs rows from one user's
    // query), and every link has an out side.
    await client.query(
      `DELETE FROM eth_activity_links l
       USING eth_activity a, eth_wallets w
       WHERE l.out_activity_id = a.id AND a.wallet_id = w.id AND w.user_id = $1`,
      [userId]
    );
    if (!links.length) return 0;

    const values = [];
    const hasBundleDetails = links.some((link) => Array.isArray(link.asset_details));
    const columns = hasBundleDetails
      ? '(out_activity_id, in_activity_id, asset, out_amount, in_amount, fee_amount, asset_details, movement_id, evidence_method)'
      : '(out_activity_id, in_activity_id, asset, out_amount, in_amount, fee_amount, movement_id, evidence_method)';
    const width = hasBundleDetails ? 9 : 8;
    const placeholders = links.map((link, i) => {
      const base = i * width;
      values.push(
        link.out_activity_id,
        link.in_activity_id,
        link.asset,
        link.out_amount,
        link.in_amount,
        link.fee_amount,
        ...(hasBundleDetails ? [link.asset_details ? JSON.stringify(link.asset_details) : null] : []),
        link.movement_id,
        link.evidence_method
      );
      return `(${Array.from({ length: width }, (_, j) => `$${base + j + 1}${hasBundleDetails && j === 6 ? '::jsonb' : ''}`).join(', ')})`;
    });

    // No ON CONFLICT clause on purpose. The source endpoint carries a UNIQUE
    // index, so a collision here means the matcher claimed one source leg twice
    // -- a bug that must surface, not a duplicate to swallow. A destination
    // may legitimately repeat when one settlement bundles several source
    // activities; each row then carries that source's conserved asset slice.
    const result = await client.query(
      `INSERT INTO eth_activity_links
         ${columns}
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
  static async syncBridgeReviewState(userId, reviewReason, client = pool) {
    if (!userId) throw new Error('EthActivityLink.syncBridgeReviewState requires a userId');

    const matched = `EXISTS (SELECT 1 FROM eth_activity_links l
                             WHERE l.out_activity_id = a.id OR l.in_activity_id = a.id)`;

    // The RESOLVED category, matching every other reader (EthActivity's
    // RESOLVED_COLUMNS) and the matcher that produced the links. A row the user
    // overrode away from bridge_out is no longer a bridge leg and this pass must
    // not touch its review state at all -- an override IS a review, and the
    // readers already report it as such. Written as a correlated subquery rather
    // than a LEFT JOIN in the FROM list because the target table of an UPDATE
    // cannot be joined against there.
    const resolvedCategory = `COALESCE(
      (SELECT o.category FROM eth_activity_overrides o
        WHERE o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash),
      a.category)`;

    await client.query(
      `UPDATE eth_activity a
       SET needs_review = FALSE, review_reason = NULL, confidence = 'high'
       FROM eth_wallets w
       WHERE a.wallet_id = w.id AND w.user_id = $1
         AND ${resolvedCategory} IN ('bridge_out', 'bridge_in')
         AND ${matched}`,
      [userId]
    );
    const result = await client.query(
      `UPDATE eth_activity a
       SET needs_review = TRUE, review_reason = $2, confidence = 'medium'
       FROM eth_wallets w
       WHERE a.wallet_id = w.id AND w.user_id = $1
         AND ${resolvedCategory} IN ('bridge_out', 'bridge_in')
         AND NOT ${matched}`,
      [userId, reviewReason]
    );
    return result.rowCount;
  }
}

module.exports = EthActivityLink;
