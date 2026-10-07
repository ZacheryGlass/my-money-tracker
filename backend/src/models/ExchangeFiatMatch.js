'use strict';

const pool = require('../config/database');
const { bankDescriptorPairs } = require('../crypto/registry/venues');

function requireUserId(userId) {
  if (!userId) throw new Error('ExchangeFiatMatch requires a userId');
}

class ExchangeFiatMatch {
  // Joins the caller's transaction when given its client (the exchange match
  // rebuild runs as one); otherwise owns a transaction of its own.
  static async rebuildForUser(userId, { client: outerClient = null } = {}) {
    requireUserId(userId);
    const ownsTransaction = !outerClient;
    const client = outerClient || await pool.connect();
    try {
      if (ownsTransaction) await client.query('BEGIN');
      await client.query(
        `DELETE FROM exchange_fiat_matches efm
         USING exchange_records er, exchange_accounts ea
         WHERE efm.exchange_record_id = er.id
           AND er.exchange_account_id = ea.id AND ea.user_id = $1`,
        [userId]
      );
      // A link is drawn only when it is the ONLY plausible pairing on both
      // sides: the record has exactly one candidate bank transaction and that
      // transaction has exactly one candidate record. Anything else (two bank
      // lines for one transfer, or one bank line for two transfers) links
      // nothing and stays visible as unmatched, the same ambiguity rule the
      // exchange/on-chain matcher follows. Nearest-day is never a tiebreak.
      const { exchanges, descriptors } = bankDescriptorPairs();
      const { rows: [outcome] } = await client.query(
        `WITH descriptors AS (
           SELECT * FROM unnest($2::text[], $3::text[]) AS d(exchange, descriptor)
         ), candidates AS (
           SELECT DISTINCT er.id AS exchange_record_id, t.id AS transaction_id,
                  ABS(er.base_amount) AS amount,
                  ABS((er.occurred_at::date - t.date::date))::int AS day_delta
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
               OR EXISTS (
                 SELECT 1 FROM descriptors d
                  WHERE d.exchange = ea.exchange
                    AND (LOWER(COALESCE(t.merchant_name, '')) LIKE '%' || d.descriptor || '%'
                      OR LOWER(COALESCE(t.name, '')) LIKE '%' || d.descriptor || '%')
               )
             )
             AND ((er.record_type = 'deposit' AND t.amount > 0)
               OR (er.record_type = 'withdrawal' AND t.amount < 0))
         ), counted AS (
           SELECT c.*,
                  COUNT(*) OVER (PARTITION BY c.exchange_record_id) AS record_candidates,
                  COUNT(*) OVER (PARTITION BY c.transaction_id) AS transaction_candidates
           FROM candidates c
         ), inserted AS (
           INSERT INTO exchange_fiat_matches
             (exchange_record_id, transaction_id, amount, day_delta)
           SELECT exchange_record_id, transaction_id, amount, day_delta
           FROM counted
           WHERE record_candidates = 1 AND transaction_candidates = 1
           ON CONFLICT DO NOTHING
           RETURNING id
         )
         SELECT (SELECT COUNT(*) FROM inserted)::int AS matched,
                (SELECT COUNT(DISTINCT exchange_record_id) FROM counted
                  WHERE record_candidates > 1 OR transaction_candidates > 1)::int AS ambiguous`,
        [userId, exchanges, descriptors]
      );
      if (ownsTransaction) await client.query('COMMIT');
      return { matched: outcome?.matched || 0, ambiguous: outcome?.ambiguous || 0 };
    } catch (error) {
      if (ownsTransaction) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
      }
      throw error;
    } finally {
      if (ownsTransaction) client.release();
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
