'use strict';

const pool = require('../config/database');
const { applyMerge } = require('./ExchangeRecord');

const VERDICTS = new Set(['same', 'different']);

function requireUserId(method, userId) {
  if (!userId) throw new Error(`ExchangeOverlapReview.${method} requires a userId`);
}

class ExchangeOverlapReview {
  static get VERDICTS() { return VERDICTS; }

  // Called after the blocked batch rolled back, outside its transaction.
  // DO NOTHING keeps a decision already made, and a pending pair the nightly
  // sync sees again is not stored twice.
  static async recordCandidates(exchangeAccountId, candidates, db = pool) {
    let recorded = 0;
    for (const candidate of candidates || []) {
      if (!candidate?.record_id || !candidate.incoming_external_id || !candidate.incoming) continue;
      const result = await db.query(
        `INSERT INTO exchange_overlap_reviews
           (exchange_account_id, record_id, incoming_external_id, incoming_record)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (exchange_account_id, record_id, incoming_external_id) DO NOTHING
         RETURNING id`,
        [exchangeAccountId, candidate.record_id, candidate.incoming_external_id,
          JSON.stringify(candidate.incoming)]
      );
      recorded += result.rows.length;
    }
    return recorded;
  }

  static async listForUser(userId, exchangeAccountId, { status = 'pending' } = {}) {
    requireUserId('listForUser', userId);
    const result = await pool.query(
      `SELECT r.id, r.status, r.incoming_external_id, r.incoming_record,
              r.reviewed_at, r.created_at,
              jsonb_build_object(
                'id', er.id, 'external_id', er.external_id, 'source', er.source,
                'record_type', er.record_type, 'occurred_at', er.occurred_at,
                'base_asset', er.base_asset, 'base_amount', er.base_amount::text,
                'fee_asset', er.fee_asset, 'fee_amount', er.fee_amount::text,
                'tx_hash', er.tx_hash, 'address', er.address, 'network', er.network
              ) AS existing_record
       FROM exchange_overlap_reviews r
       JOIN exchange_accounts ea ON ea.id = r.exchange_account_id AND ea.user_id = $1
       JOIN exchange_records er ON er.id = r.record_id
       WHERE r.exchange_account_id = $2
         AND ($3::text IS NULL OR r.status = $3::text)
       ORDER BY er.occurred_at, r.id`,
      [userId, exchangeAccountId, status]
    );
    return result.rows;
  }

  // 'same' is a one-way door like any merge: the stored record absorbs the
  // incoming payload and the audit row turns later replays into duplicates.
  // 'different' lets the incoming record import as its own event.
  static async decideForUser(userId, exchangeAccountId, reviewId, verdict) {
    requireUserId('decideForUser', userId);
    if (!VERDICTS.has(verdict)) throw new Error(`verdict must be one of: ${[...VERDICTS].join(', ')}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT r.*
         FROM exchange_overlap_reviews r
         JOIN exchange_accounts ea ON ea.id = r.exchange_account_id AND ea.user_id = $1
         WHERE r.id = $2 AND r.exchange_account_id = $3
         FOR UPDATE OF r`,
        [userId, reviewId, exchangeAccountId]
      );
      const review = found.rows[0];
      if (!review || review.status !== 'pending') {
        await client.query('ROLLBACK');
        return { row: review || null, conflict: Boolean(review) };
      }
      if (verdict === 'same') {
        const survivor = await client.query(
          'SELECT * FROM exchange_records WHERE id = $1 AND exchange_account_id = $2 FOR UPDATE',
          [review.record_id, exchangeAccountId]
        );
        const claimed = await client.query(
          `SELECT 1 FROM exchange_record_dedupe_events
           WHERE exchange_account_id = $1 AND incoming_external_id = $2`,
          [exchangeAccountId, review.incoming_external_id]
        );
        if (!survivor.rows[0] || claimed.rows.length) {
          await client.query('ROLLBACK');
          return { row: review, conflict: true };
        }
        await applyMerge(client, exchangeAccountId, survivor.rows[0], review.incoming_record);
        // One provider event is one stored event: neither side of this pair
        // can also be the same as anything else still pending.
        await client.query(
          `UPDATE exchange_overlap_reviews
           SET status = 'rejected', reviewer_id = $4, reviewed_at = CURRENT_TIMESTAMP
           WHERE exchange_account_id = $1 AND id <> $2 AND status = 'pending'
             AND (incoming_external_id = $3 OR record_id = $5)`,
          [exchangeAccountId, review.id, review.incoming_external_id, userId, review.record_id]
        );
      }
      const updated = await client.query(
        `UPDATE exchange_overlap_reviews
         SET status = $2, reviewer_id = $3, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [review.id, verdict === 'same' ? 'confirmed' : 'rejected', userId]
      );
      await client.query('COMMIT');
      return { row: updated.rows[0], conflict: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = ExchangeOverlapReview;
