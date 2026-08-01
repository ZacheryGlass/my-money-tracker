'use strict';

const pool = require('../config/database');

function requireUserId(userId) {
  if (!userId) throw new Error('ExchangeFiatMatch requires a userId');
}

class ExchangeFiatMatch {
  static async rebuildForUser(userId) {
    requireUserId(userId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM exchange_fiat_matches efm
         USING exchange_records er, exchange_accounts ea
         WHERE efm.exchange_record_id = er.id
           AND er.exchange_account_id = ea.id AND ea.user_id = $1`,
        [userId]
      );
      const inserted = await client.query(
        `WITH candidates AS (
           SELECT er.id AS exchange_record_id, t.id AS transaction_id,
                  ABS(er.base_amount) AS amount,
                  ABS((er.occurred_at::date - t.date::date))::int AS day_delta,
                  ROW_NUMBER() OVER (
                    PARTITION BY er.id
                    ORDER BY ABS((er.occurred_at::date - t.date::date)), t.id
                  ) AS record_rank,
                  ROW_NUMBER() OVER (
                    PARTITION BY t.id
                    ORDER BY ABS((er.occurred_at::date - t.date::date)), er.id
                  ) AS transaction_rank
           FROM exchange_records er
           JOIN exchange_accounts ea ON ea.id = er.exchange_account_id AND ea.user_id = $1
           JOIN transactions t
             ON ABS(t.amount::numeric) = ABS(er.base_amount::numeric)
            AND t.date BETWEEN er.occurred_at::date - 7 AND er.occurred_at::date + 7
           JOIN accounts ba ON ba.id = t.account_id AND ba.user_id = $1
           CROSS JOIN LATERAL (
             SELECT GREATEST(COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM day) BETWEEN 1 AND 5) - 1, 0)::int AS business_day_delta
             FROM generate_series(
               LEAST(er.occurred_at::date, t.date::date),
               GREATEST(er.occurred_at::date, t.date::date),
               INTERVAL '1 day'
             ) AS days(day)
           ) business_days
           WHERE er.record_type IN ('deposit', 'withdrawal')
             AND UPPER(er.base_asset) IN ('USD', 'USDC', 'EUR', 'GBP', 'CAD')
             AND t.plaid_transaction_id IS NOT NULL
             AND business_days.business_day_delta <= 5
             AND (
               LOWER(COALESCE(t.merchant_name, '')) LIKE '%' || LOWER(ea.name) || '%'
               OR LOWER(COALESCE(t.name, '')) LIKE '%' || LOWER(ea.name) || '%'
               OR LOWER(COALESCE(t.merchant_name, '')) LIKE '%' || LOWER(ea.exchange) || '%'
               OR LOWER(COALESCE(t.name, '')) LIKE '%' || LOWER(ea.exchange) || '%'
             )
             AND ((er.record_type = 'deposit' AND t.amount > 0)
               OR (er.record_type = 'withdrawal' AND t.amount < 0))
         )
         , unique_candidates AS (
           SELECT DISTINCT ON (exchange_record_id)
                  exchange_record_id, transaction_id, amount, day_delta
           FROM candidates
           WHERE record_rank = 1
           ORDER BY exchange_record_id, day_delta, transaction_id
         ), assigned AS (
           SELECT DISTINCT ON (transaction_id)
                  exchange_record_id, transaction_id, amount, day_delta
           FROM unique_candidates
           ORDER BY transaction_id, day_delta, exchange_record_id
         )
         INSERT INTO exchange_fiat_matches
           (exchange_record_id, transaction_id, amount, day_delta)
         SELECT exchange_record_id, transaction_id, amount, day_delta
         FROM assigned
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId]
      );
      await client.query(
        `UPDATE exchange_records er
         SET needs_review = CASE WHEN EXISTS (
               SELECT 1 FROM exchange_fiat_matches efm
               WHERE efm.exchange_record_id = er.id
             ) THEN FALSE ELSE TRUE END
         FROM exchange_accounts ea
         WHERE ea.id = er.exchange_account_id AND ea.user_id = $1
           AND er.record_type IN ('deposit', 'withdrawal')
           AND UPPER(er.base_asset) IN ('USD', 'USDC', 'EUR', 'GBP', 'CAD')`,
        [userId]
      );
      await client.query('COMMIT');
      return { matched: inserted.rowCount || 0 };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
      throw error;
    } finally {
      client.release();
    }
  }

  static async findForUser(userId, { limit = 100, offset = 0 } = {}) {
    requireUserId(userId);
    const result = await pool.query(
      `SELECT efm.*, er.external_id, er.record_type, er.occurred_at,
              er.base_asset, er.base_amount, ea.name AS exchange_account_name,
              t.date, t.name AS bank_name, t.merchant_name, t.amount AS bank_amount,
              a.name AS bank_account_name,
              COUNT(*) OVER() AS total_count
       FROM exchange_fiat_matches efm
       JOIN exchange_records er ON er.id = efm.exchange_record_id
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id AND ea.user_id = $1
       JOIN transactions t ON t.id = efm.transaction_id
       JOIN accounts a ON a.id = t.account_id AND a.user_id = $1
       ORDER BY er.occurred_at DESC, efm.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return {
      matches: result.rows.map((row) => {
        const clean = { ...row };
        delete clean.total_count;
        return clean;
      }),
      total,
    };
  }
}

module.exports = ExchangeFiatMatch;
