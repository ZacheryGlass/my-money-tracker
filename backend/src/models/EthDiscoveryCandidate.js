'use strict';

const pool = require('../config/database');
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

const STATUSES = new Set(['pending', 'confirmed_own', 'dismissed']);

function assertUser(userId, method) {
  if (!Number.isInteger(userId) || userId < 1) {
    throw new Error(`EthDiscoveryCandidate.${method} requires a userId`);
  }
}

class EthDiscoveryCandidate {
  static async pendingFrontier(userId, limit = 25, maxDepth = 3) {
    assertUser(userId, 'pendingFrontier');
    const result = await pool.query(
      `WITH frontier AS (
         SELECT c.id, c.user_id, c.address, c.chain_id, c.score, c.evidence,
                COALESCE((
                  SELECT MAX(CASE WHEN item->>'hop_depth' ~ '^[0-9]+$'
                                  THEN (item->>'hop_depth')::int END)
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(c.evidence) = 'array'
                         THEN c.evidence ELSE jsonb_build_array(c.evidence) END
                  ) item
                ), 0)::int AS depth
         FROM eth_discovery_candidates c
         WHERE c.user_id = $1 AND c.status = 'pending'
           AND c.source IN ('path', 'exchange_withdrawal')
       )
       SELECT f.id, f.address, f.chain_id, f.score, f.evidence, f.depth
       FROM frontier f
       WHERE f.depth < $3
         AND NOT EXISTS (
         SELECT 1
         FROM eth_discovery_fetches r
         WHERE r.user_id = f.user_id
           AND r.address = f.address
           AND r.chain_id = f.chain_id
           AND r.depth = f.depth
           AND r.status IN ('complete', 'contract', 'high_traffic', 'dust', 'unsupported')
       )
       ORDER BY f.score DESC NULLS LAST, f.id ASC
       LIMIT $2`,
      [userId, limit, maxDepth]
    );
    return result.rows;
  }

  static async findKnownAddress(userId, address) {
    assertUser(userId, 'findKnownAddress');
    if (!ADDRESS_RE.test(String(address || ''))) return false;
    const result = await pool.query(
      `SELECT 1 FROM eth_wallets WHERE user_id = $1 AND address = LOWER($2)
       UNION ALL
       SELECT 1 FROM eth_address_labels
       WHERE address = LOWER($2) AND (user_id = $1 OR user_id IS NULL)
       LIMIT 1`,
      [userId, address]
    );
    return Boolean(result.rows[0]);
  }

  static async recordFetch(userId, { address, chainId, depth, status, rowsFetched = 0, errorMessage = null }) {
    assertUser(userId, 'recordFetch');
    await pool.query(
      `INSERT INTO eth_discovery_fetches
         (user_id, address, chain_id, depth, status, rows_fetched, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, address, chain_id, depth) DO UPDATE SET
         status = EXCLUDED.status, rows_fetched = EXCLUDED.rows_fetched,
         error_message = EXCLUDED.error_message, fetched_at = CURRENT_TIMESTAMP`,
      [userId, address.toLowerCase(), chainId, depth, status, rowsFetched, errorMessage]
    );
  }

  static async upsertPath(userId, { address, chainId, score, evidence }) {
    assertUser(userId, 'upsertPath');
    const result = await pool.query(
      `INSERT INTO eth_discovery_candidates (user_id, address, chain_id, source, score, evidence)
       VALUES ($1, LOWER($2), $3, 'path', $4, $5::jsonb)
       ON CONFLICT (user_id, address, chain_id) DO UPDATE SET
         score = CASE WHEN eth_discovery_candidates.status = 'pending'
                      THEN GREATEST(eth_discovery_candidates.score, EXCLUDED.score)
                      ELSE eth_discovery_candidates.score END,
         evidence = CASE WHEN eth_discovery_candidates.status = 'pending'
                         THEN EXCLUDED.evidence ELSE eth_discovery_candidates.evidence END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId, address, chainId, score, JSON.stringify(evidence)]
    );
    return result.rows[0] || null;
  }

  static async seed(userId) {
    assertUser(userId, 'seed');
    // The path arm is deliberately one intermediary: both legs are already in
    // the user's ledger, so it is proof-backed and does not require an API
    // expansion. Amount and token identity must be conserved within a small
    // window; the tolerance covers gas and ordinary fee-on-transfer dust.
    const result = await pool.query(
      `WITH known AS (
         SELECT id, address FROM eth_wallets WHERE user_id = $1
       ), inbound AS (
         SELECT t.id, t.chain_id, t.tx_hash, t.block_time, t.from_address,
                t.to_address AS candidate, t.token_contract, t.token_symbol,
                ABS(t.value_wei::numeric) AS amount
         FROM eth_transfers t
         JOIN known w ON w.address = t.from_address
         WHERE t.transfer_type <> 'gas' AND t.is_error = FALSE
           AND t.to_address IS NOT NULL
           AND t.to_address ~ '^0x[0-9a-fA-F]{40}$'
           AND t.to_address <> '0x0000000000000000000000000000000000000000'
       ), outbound AS (
         SELECT t.id, t.chain_id, t.tx_hash, t.block_time, t.from_address AS candidate,
                t.to_address, t.token_contract, t.token_symbol,
                ABS(t.value_wei::numeric) AS amount
         FROM eth_transfers t
         JOIN known w ON w.address = t.to_address
         WHERE t.transfer_type <> 'gas' AND t.is_error = FALSE
           AND t.from_address IS NOT NULL
           AND t.from_address ~ '^0x[0-9a-fA-F]{40}$'
           AND t.from_address <> '0x0000000000000000000000000000000000000000'
       ), paths AS (
         SELECT i.candidate, i.chain_id,
                jsonb_build_object(
                  'type', 'one_hop',
                  'inbound', jsonb_build_object(
                    'transfer_id', i.id, 'tx_hash', i.tx_hash,
                    'block_time', i.block_time, 'from_address', i.from_address,
                    'amount', i.amount, 'token_contract', i.token_contract,
                    'token_symbol', i.token_symbol),
                  'outbound', jsonb_build_object(
                    'transfer_id', o.id, 'tx_hash', o.tx_hash,
                    'block_time', o.block_time, 'to_address', o.to_address,
                    'amount', o.amount, 'token_contract', o.token_contract,
                    'token_symbol', o.token_symbol)
                ) AS evidence,
                CASE WHEN i.amount = 0 THEN 0.5
                     ELSE GREATEST(0.5, 1 - ABS(i.amount - o.amount) / i.amount)
                END AS score
         FROM inbound i
         JOIN outbound o
           ON o.candidate = i.candidate
          AND o.chain_id = i.chain_id
          AND o.block_time > i.block_time
          AND o.block_time <= i.block_time + INTERVAL '30 days'
          AND o.token_contract IS NOT DISTINCT FROM i.token_contract
          AND ABS(i.amount - o.amount) <= GREATEST(i.amount * 0.02, 1)
         WHERE NOT EXISTS (
           SELECT 1 FROM eth_wallets w
           WHERE w.user_id = $1 AND w.address = i.candidate
         )
           AND NOT EXISTS (
             SELECT 1 FROM eth_address_labels l
             WHERE l.address = i.candidate AND (l.user_id = $1 OR l.user_id IS NULL)
           )
           AND NOT EXISTS (
             SELECT 1 FROM eth_ignored_tokens it
             WHERE it.user_id = $1 AND it.contract_address = i.token_contract
           )
       ), exchange_seeds AS (
         SELECT LOWER(er.address) AS candidate,
                COALESCE(er.chain_id, 0)::int AS chain_id,
                jsonb_build_object(
                  'type', 'exchange_withdrawal',
                  'exchange_record_id', er.id,
                  'exchange_account_id', er.exchange_account_id,
                  'occurred_at', er.occurred_at,
                  'asset', er.base_asset,
                  'amount', er.base_amount,
                  'network', er.network,
                  'chain_id', er.chain_id
                ) AS evidence
         FROM exchange_records er
         JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
         WHERE ea.user_id = $1 AND er.record_type = 'withdrawal'
           AND er.address ~* '^0x[0-9a-f]{40}$'
           AND NOT EXISTS (
             SELECT 1 FROM eth_wallets w
             WHERE w.user_id = $1 AND w.address = LOWER(er.address)
           )
           AND NOT EXISTS (
             SELECT 1 FROM eth_address_labels l
             WHERE l.address = LOWER(er.address) AND (l.user_id = $1 OR l.user_id IS NULL)
           )
       ), all_candidates AS (
         SELECT candidate, chain_id, 'path' AS source, evidence, score FROM paths
         UNION ALL
         SELECT candidate, chain_id, 'exchange_withdrawal' AS source, evidence, 0.95::numeric FROM exchange_seeds
       )
       INSERT INTO eth_discovery_candidates (user_id, address, chain_id, source, score, evidence)
       SELECT $1, candidate, chain_id, source, MAX(score), jsonb_agg(evidence)
       FROM all_candidates
       GROUP BY candidate, chain_id, source
       ON CONFLICT (user_id, address, chain_id) DO UPDATE SET
         source = CASE WHEN eth_discovery_candidates.status = 'pending'
                       THEN EXCLUDED.source ELSE eth_discovery_candidates.source END,
         score = CASE WHEN eth_discovery_candidates.status = 'pending'
                      THEN GREATEST(eth_discovery_candidates.score, EXCLUDED.score)
                      ELSE eth_discovery_candidates.score END,
         evidence = CASE WHEN eth_discovery_candidates.status = 'pending'
                         THEN EXCLUDED.evidence ELSE eth_discovery_candidates.evidence END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId]
    );
    return result.rows;
  }

  static async findForUser(userId, { status = null, limit = 100, offset = 0 } = {}) {
    assertUser(userId, 'findForUser');
    const params = [userId];
    const filters = ['user_id = $1'];
    if (status !== null) {
      if (!STATUSES.has(status)) throw new Error(`Invalid discovery status: ${status}`);
      params.push(status);
      filters.push(`status = $${params.length}`);
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT *, COUNT(*) OVER() AS total_count
         FROM eth_discovery_candidates
        WHERE ${filters.join(' AND ')}
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, score DESC NULLS LAST, id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      candidates: result.rows.map((row) => {
        const clean = { ...row };
        delete clean.total_count;
        return clean;
      }),
      total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    };
  }

  static async fetchReceiptsForUser(userId, { limit = 100, offset = 0 } = {}) {
    assertUser(userId, 'fetchReceiptsForUser');
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const result = await pool.query(
      `SELECT r.id, r.address, r.chain_id, r.depth, r.status, r.rows_fetched,
              r.error_message, r.fetched_at, c.source, c.score
       FROM eth_discovery_fetches r
       LEFT JOIN eth_discovery_candidates c
         ON c.user_id = r.user_id AND c.address = r.address AND c.chain_id = r.chain_id
       WHERE r.user_id = $1
       ORDER BY r.fetched_at DESC, r.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, safeLimit, safeOffset]
    );
    return result.rows;
  }

  static async findByIdForUser(userId, id) {
    assertUser(userId, 'findByIdForUser');
    if (!Number.isInteger(id) || id < 1) return null;
    const result = await pool.query(
      'SELECT * FROM eth_discovery_candidates WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0] || null;
  }

  static async decide(userId, id, status) {
    assertUser(userId, 'decide');
    if (!Number.isInteger(id) || id < 1 || !STATUSES.has(status) || status === 'pending') return null;
    const result = await pool.query(
      `UPDATE eth_discovery_candidates
          SET status = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [id, userId, status]
    );
    return result.rows[0] || null;
  }
}

module.exports = EthDiscoveryCandidate;
