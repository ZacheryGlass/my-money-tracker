'use strict';

const pool = require('../config/database');

const FEEDS = new Set(['normal', 'internal', 'token', 'nft', 'nft1155', 'statesync']);
const STATUSES = new Set(['complete', 'failed', 'unsupported', 'not_applicable', 'unverified']);
const CURSOR_KINDS = new Set(['evm_block', 'archive_serial']);

// One upsert for a chain's six verdicts. Besides avoiding six round trips, this
// makes the report change as one snapshot: readers cannot observe three feeds
// from tonight and three from yesterday in the middle of a sync.
class EthFeedCoverage {
  static async recordAttempts(walletId, chainId, entries) {
    if (!Number.isInteger(walletId) || !Number.isInteger(chainId)) {
      throw new Error('EthFeedCoverage.recordAttempts requires integer wallet and chain ids');
    }
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const seen = new Set();
    const values = [];
    const params = [];
    for (const entry of entries) {
      if (!FEEDS.has(entry.feed) || !STATUSES.has(entry.status)
          || !CURSOR_KINDS.has(entry.cursorKind || 'evm_block')) {
        throw new Error(`Invalid feed coverage entry for ${entry.feed || 'unknown'}`);
      }
      if (seen.has(entry.feed)) throw new Error(`Duplicate feed coverage entry for ${entry.feed}`);
      seen.add(entry.feed);
      if (entry.status === 'complete'
          && (entry.coveredFromBlock == null || entry.coveredThroughBlock == null)) {
        throw new Error(`Complete feed coverage requires both boundaries for ${entry.feed}`);
      }
      if (['failed', 'unsupported'].includes(entry.status) && !entry.errorMessage) {
        throw new Error(`Failed feed coverage requires an error message for ${entry.feed}`);
      }

      const offset = params.length;
      params.push(
        walletId,
        chainId,
        entry.feed,
        entry.cursorKind || 'evm_block',
        entry.provider,
        entry.status,
        entry.coveredFromBlock ?? null,
        entry.coveredThroughBlock ?? null,
        entry.coveredFromAt ?? null,
        entry.coveredThroughAt ?? null,
        entry.indexedHead ?? null,
        entry.attemptedFromBlock ?? null,
        entry.errorCode ?? null,
        entry.errorMessage ?? null
      );
      values.push(`(
        $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4},
        $${offset + 5}, $${offset + 6}::varchar(20), $${offset + 7}, $${offset + 8},
        $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12},
        $${offset + 13}, $${offset + 14},
        CASE WHEN $${offset + 6}::text = 'complete' THEN CURRENT_TIMESTAMP ELSE NULL END
      )`);
    }

    const result = await pool.query(
      `INSERT INTO eth_feed_coverage (
         wallet_id, chain_id, feed, cursor_kind, provider, status,
         covered_from_block, covered_through_block,
         covered_from_at, covered_through_at, indexed_head,
         attempted_from_block, error_code, error_message, last_success_at
       ) VALUES ${values.join(',')}
       ON CONFLICT (wallet_id, chain_id, feed) DO UPDATE SET
         cursor_kind = EXCLUDED.cursor_kind,
         provider = EXCLUDED.provider,
         status = EXCLUDED.status,
         covered_from_block = CASE
           WHEN EXCLUDED.status = 'complete' THEN
             COALESCE(
               LEAST(eth_feed_coverage.covered_from_block, EXCLUDED.covered_from_block),
               eth_feed_coverage.covered_from_block,
               EXCLUDED.covered_from_block
             )
           WHEN EXCLUDED.status = 'not_applicable' THEN NULL
           ELSE eth_feed_coverage.covered_from_block
         END,
         covered_through_block = CASE
           WHEN EXCLUDED.status = 'complete' THEN EXCLUDED.covered_through_block
           WHEN EXCLUDED.status = 'not_applicable' THEN NULL
           ELSE eth_feed_coverage.covered_through_block
         END,
         covered_from_at = CASE
           WHEN EXCLUDED.status = 'complete' THEN
             COALESCE(
               LEAST(eth_feed_coverage.covered_from_at, EXCLUDED.covered_from_at),
               eth_feed_coverage.covered_from_at,
               EXCLUDED.covered_from_at
             )
           WHEN EXCLUDED.status = 'not_applicable' THEN NULL
           ELSE eth_feed_coverage.covered_from_at
         END,
         covered_through_at = CASE
           WHEN EXCLUDED.status = 'complete' THEN EXCLUDED.covered_through_at
           WHEN EXCLUDED.status = 'not_applicable' THEN NULL
           ELSE eth_feed_coverage.covered_through_at
         END,
         indexed_head = EXCLUDED.indexed_head,
         attempted_from_block = EXCLUDED.attempted_from_block,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message,
         last_attempt_at = CURRENT_TIMESTAMP,
         last_success_at = CASE
           WHEN EXCLUDED.status = 'complete' THEN CURRENT_TIMESTAMP
           ELSE eth_feed_coverage.last_success_at
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      params
    );
    return result.rows;
  }

  static async findForUser(userId) {
    if (!Number.isInteger(userId)) throw new Error('EthFeedCoverage.findForUser requires a userId');
    const result = await pool.query(
      `SELECT c.*,
              w.address AS wallet_address,
              w.label AS wallet_label,
              wc.last_synced_at AS chain_last_synced_at,
              wc.error_code AS chain_error_code,
              wc.error_message AS chain_error_message
         FROM eth_feed_coverage c
         JOIN eth_wallets w ON w.id = c.wallet_id
         LEFT JOIN eth_wallet_chains wc
           ON wc.wallet_id = c.wallet_id AND wc.chain_id = c.chain_id
        WHERE w.user_id = $1
        ORDER BY w.id, c.chain_id, c.feed`,
      [userId]
    );
    return result.rows;
  }
}

module.exports = EthFeedCoverage;
