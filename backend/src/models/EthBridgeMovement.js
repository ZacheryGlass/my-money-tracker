'use strict';

const pool = require('../config/database');
const EthActivityLink = require('./EthActivityLink');

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ACTIVE_STATUSES = new Set(['protocol_verified', 'user_confirmed']);
const DESTINATION_ROLES = new Set(['destination_execution', 'fill', 'finalization']);
const lower = (value) => String(value || '').toLowerCase();
const coordinate = (walletId, chainId, txHash) => `${Number(walletId)}:${Number(chainId)}:${lower(txHash)}`;

function projectionAmounts(outActivity, inActivity) {
  const outLegs = (outActivity.legs || []).filter((leg) => leg.direction === 'out');
  const inLegs = (inActivity.legs || []).filter((leg) => leg.direction === 'in');
  if (outLegs.length === 1 && inLegs.length === 1
      && outLegs[0].asset === inLegs[0].asset
      && /^\d+(?:\.\d+)?$/.test(String(outLegs[0].amount))
      && /^\d+(?:\.\d+)?$/.test(String(inLegs[0].amount))) {
    const outAmount = String(outLegs[0].amount);
    const inAmount = String(inLegs[0].amount);
    // NUMERIC subtraction is left to Postgres on insert in the old model, so
    // avoid binary floats here. The compatibility fee is display-only; exact
    // protocol fee fields live on movement members.
    return { asset: outLegs[0].asset, out_amount: outAmount, in_amount: inAmount, fee_amount: '0' };
  }
  return { asset: 'BRIDGE', out_amount: '0', in_amount: '0', fee_amount: '0' };
}

class EthBridgeMovement {
  static async findVerdictsForUser(userId, client = pool) {
    const { rows } = await client.query(
      `SELECT * FROM eth_bridge_verdicts WHERE user_id = $1 ORDER BY id`,
      [userId]
    );
    return rows;
  }

  static async findRejectedPairKeys(userId, client = pool) {
    const verdicts = await this.findVerdictsForUser(userId, client);
    return new Set(verdicts.filter((row) => row.verdict === 'rejected').map((row) => (
      `${coordinate(row.out_wallet_id, row.out_chain_id, row.out_tx_hash)}>`
      + coordinate(row.in_wallet_id, row.in_chain_id, row.in_tx_hash)
    )));
  }

  static async replaceForUser(userId, movements, suggestions, clientOverride = null) {
    if (!userId) throw new Error('EthBridgeMovement.replaceForUser requires a userId');
    if (!Array.isArray(movements) || !Array.isArray(suggestions)) {
      throw new TypeError('Bridge movement rebuild requires movement and suggestion arrays');
    }
    const client = clientOverride || await pool.connect();
    const ownsTransaction = clientOverride == null;
    try {
      if (ownsTransaction) await client.query('BEGIN');
      await client.query(
        `UPDATE eth_bridge_movements
            SET status = 'invalidated', invalidated_at = NOW(),
                invalidation_reason = 'not_reproduced_by_current_evidence', updated_at = NOW()
          WHERE user_id = $1 AND status <> 'invalidated'`,
        [userId]
      );

      const persisted = [];
      for (const movement of movements) {
        const { rows } = await client.query(
          `INSERT INTO eth_bridge_movements
             (user_id, protocol, family_version, status, verification_method,
              correlation_key, rule_version, evidence, invalidated_at, invalidation_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NULL, NULL)
           ON CONFLICT (user_id, protocol, family_version, correlation_key) DO UPDATE SET
             status = EXCLUDED.status, verification_method = EXCLUDED.verification_method,
             rule_version = EXCLUDED.rule_version, evidence = EXCLUDED.evidence,
             updated_at = NOW(), invalidated_at = NULL, invalidation_reason = NULL
           RETURNING *`,
          [
            userId, movement.protocol, movement.family_version, movement.status,
            movement.verification_method, movement.correlation_key, movement.rule_version,
            JSON.stringify(movement.evidence || {}),
          ]
        );
        const stored = rows[0];
        persisted.push({ ...movement, id: Number(stored.id) });
        await client.query('DELETE FROM eth_bridge_movement_members WHERE movement_id = $1', [stored.id]);
        for (const member of movement.members || []) {
          await client.query(
            `INSERT INTO eth_bridge_movement_members
               (movement_id, wallet_id, chain_id, tx_hash, role, receipt_id,
                log_index, asset_id, amount, fee_amount, evidence)
             SELECT $1, w.id, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
               FROM eth_wallets w
              WHERE w.id = $2 AND w.user_id = $12
             ON CONFLICT (movement_id, wallet_id, chain_id, tx_hash, role) DO UPDATE SET
               receipt_id = EXCLUDED.receipt_id, log_index = EXCLUDED.log_index,
               asset_id = EXCLUDED.asset_id, amount = EXCLUDED.amount,
               fee_amount = EXCLUDED.fee_amount, evidence = EXCLUDED.evidence`,
            [
              stored.id, member.wallet_id, member.chain_id, lower(member.tx_hash), member.role,
              member.receipt_id || null, member.log_index ?? null, member.asset_id || null,
              member.amount ?? null, member.fee_amount ?? null,
              JSON.stringify(member.evidence || {}), userId,
            ]
          );
        }
      }

      await client.query(
        `DELETE FROM eth_bridge_suggestions WHERE user_id = $1 AND source = 'derived'`,
        [userId]
      );
      for (const suggestion of suggestions) {
        await client.query(
          `INSERT INTO eth_bridge_suggestions
             (user_id, out_wallet_id, out_chain_id, out_tx_hash,
              in_wallet_id, in_chain_id, in_tx_hash, protocol, family_version,
              suggestion_reason, ambiguous, rule_version, evidence, source)
           SELECT $1, ow.id, $3, $4, iw.id, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'derived'
             FROM eth_wallets ow, eth_wallets iw
            WHERE ow.id = $2 AND ow.user_id = $1 AND iw.id = $5 AND iw.user_id = $1
           ON CONFLICT (user_id, out_wallet_id, out_chain_id, out_tx_hash,
                        in_wallet_id, in_chain_id, in_tx_hash, suggestion_reason)
           DO UPDATE SET protocol = EXCLUDED.protocol, family_version = EXCLUDED.family_version,
             ambiguous = EXCLUDED.ambiguous, rule_version = EXCLUDED.rule_version,
             evidence = EXCLUDED.evidence, source = 'derived', created_at = NOW()`,
          [
            userId, suggestion.out_wallet_id, suggestion.out_chain_id, lower(suggestion.out_tx_hash),
            suggestion.in_wallet_id, suggestion.in_chain_id, lower(suggestion.in_tx_hash),
            suggestion.protocol || null, suggestion.family_version || null,
            suggestion.suggestion_reason, suggestion.ambiguous === true,
            suggestion.rule_version, JSON.stringify(suggestion.evidence || {}),
          ]
        );
      }

      if (ownsTransaction) await client.query('COMMIT');
      return persisted;
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (ownsTransaction) client.release();
    }
  }

  static async rebuildProjectionForUser(userId, client = pool) {
    // A supplied client may be inside the atomic bridge rebuild transaction.
    // Keep its statements sequential: node-postgres clients serialize today,
    // but relying on concurrent query promises obscures the transaction order.
    const { rows: activityRows } = await client.query(
        `SELECT a.id, a.wallet_id, a.chain_id, a.tx_hash, a.legs,
                COALESCE(o.category, a.category) AS category
           FROM eth_activity a
           JOIN eth_wallets w ON w.id = a.wallet_id
           LEFT JOIN eth_activity_overrides o
             ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
          WHERE w.user_id = $1`,
        [userId]
      );
    const { rows: movementRows } = await client.query(
        `SELECT m.id, m.status, m.verification_method,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'wallet_id', mm.wallet_id, 'chain_id', mm.chain_id,
                  'tx_hash', mm.tx_hash, 'role', mm.role
                ) ORDER BY mm.id) FILTER (WHERE mm.id IS NOT NULL), '[]'::jsonb) AS members
           FROM eth_bridge_movements m
           LEFT JOIN eth_bridge_movement_members mm ON mm.movement_id = m.id
          WHERE m.user_id = $1 AND m.invalidated_at IS NULL
            AND m.status IN ('protocol_verified', 'user_confirmed')
          GROUP BY m.id
          ORDER BY m.id`,
        [userId]
      );
    const activities = new Map(activityRows.map((row) => [
      coordinate(row.wallet_id, row.chain_id, row.tx_hash), row,
    ]));
    const links = [];
    for (const movement of movementRows) {
      if (!ACTIVE_STATUSES.has(movement.status)) continue;
      const members = Array.isArray(movement.members) ? movement.members : [];
      const sourceMembers = members.filter((member) => member.role === 'initiation');
      const destinationMembers = members.filter((member) => DESTINATION_ROLES.has(member.role));
      if (sourceMembers.length !== 1 || destinationMembers.length !== 1) continue;
      const out = activities.get(coordinate(
        sourceMembers[0].wallet_id, sourceMembers[0].chain_id, sourceMembers[0].tx_hash
      ));
      const incoming = activities.get(coordinate(
        destinationMembers[0].wallet_id, destinationMembers[0].chain_id, destinationMembers[0].tx_hash
      ));
      if (!out || !incoming || out.category !== 'bridge_out' || incoming.category !== 'bridge_in') continue;
      links.push({
        out_activity_id: out.id,
        in_activity_id: incoming.id,
        movement_id: Number(movement.id),
        evidence_method: movement.verification_method,
        ...projectionAmounts(out, incoming),
      });
    }
    return EthActivityLink.replaceForUser(userId, links, client);
  }

  static async findAuditForUser(userId, { limit = 500, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const [movements, suggestions, verdicts, receiptFailures, summary] = await Promise.all([
      pool.query(
        `SELECT m.*,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'wallet_id', mm.wallet_id, 'wallet_address', w.address,
                  'chain_id', mm.chain_id, 'tx_hash', mm.tx_hash, 'role', mm.role,
                  'asset_id', mm.asset_id, 'amount', mm.amount::text,
                  'fee_amount', mm.fee_amount::text, 'evidence', mm.evidence
                ) ORDER BY mm.id) FILTER (WHERE mm.id IS NOT NULL), '[]'::jsonb) AS members
           FROM eth_bridge_movements m
           LEFT JOIN eth_bridge_movement_members mm ON mm.movement_id = m.id
           LEFT JOIN eth_wallets w ON w.id = mm.wallet_id AND w.user_id = m.user_id
          WHERE m.user_id = $1
          GROUP BY m.id
          ORDER BY m.updated_at DESC, m.id DESC
          LIMIT $2 OFFSET $3`,
        [userId, safeLimit, safeOffset]
      ),
      pool.query(
        `SELECT s.*, ow.address AS out_wallet_address, iw.address AS in_wallet_address,
                v.verdict
           FROM eth_bridge_suggestions s
           JOIN eth_wallets ow ON ow.id = s.out_wallet_id AND ow.user_id = s.user_id
           JOIN eth_wallets iw ON iw.id = s.in_wallet_id AND iw.user_id = s.user_id
           LEFT JOIN eth_bridge_verdicts v
             ON v.user_id = s.user_id
            AND v.out_wallet_id = s.out_wallet_id AND v.out_chain_id = s.out_chain_id
            AND v.out_tx_hash = s.out_tx_hash
            AND v.in_wallet_id = s.in_wallet_id AND v.in_chain_id = s.in_chain_id
            AND v.in_tx_hash = s.in_tx_hash
          WHERE s.user_id = $1 AND v.id IS NULL
          ORDER BY s.ambiguous DESC, s.created_at DESC, s.id DESC
          LIMIT $2 OFFSET $3`,
        [userId, safeLimit, safeOffset]
      ),
      pool.query(
        `SELECT v.*, ow.address AS out_wallet_address, iw.address AS in_wallet_address
           FROM eth_bridge_verdicts v
           JOIN eth_wallets ow ON ow.id = v.out_wallet_id AND ow.user_id = v.user_id
           JOIN eth_wallets iw ON iw.id = v.in_wallet_id AND iw.user_id = v.user_id
          WHERE v.user_id = $1
          ORDER BY v.updated_at DESC, v.id DESC
          LIMIT $2 OFFSET $3`,
        [userId, safeLimit, safeOffset]
      ),
      pool.query(
        `SELECT latest.*
           FROM (
             SELECT DISTINCT ON (a.wallet_id, a.chain_id, a.tx_hash)
                    a.id, a.wallet_id, a.chain_id, a.tx_hash, a.provider,
                    a.status, a.provider_boundary, a.error_code,
                    a.error_detail, a.attempted_at
               FROM eth_bridge_receipt_attempts a
               JOIN eth_wallets w ON w.id = a.wallet_id
              WHERE w.user_id = $1
              ORDER BY a.wallet_id, a.chain_id, a.tx_hash, a.attempted_at DESC, a.id DESC
           ) latest
          WHERE latest.status IN ('failed', 'unsupported')
          ORDER BY latest.attempted_at DESC, latest.id DESC
          LIMIT $2 OFFSET $3`,
        [userId, safeLimit, safeOffset]
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM eth_bridge_movements WHERE user_id = $1) AS movements,
           (SELECT COUNT(*)::int FROM eth_bridge_movements
             WHERE user_id = $1 AND status = 'protocol_verified' AND invalidated_at IS NULL) AS protocol_verified,
           (SELECT COUNT(*)::int FROM eth_bridge_movements
             WHERE user_id = $1 AND status = 'user_confirmed' AND invalidated_at IS NULL) AS user_confirmed,
           (SELECT COUNT(*)::int FROM eth_bridge_movements
             WHERE user_id = $1 AND status = 'pending' AND invalidated_at IS NULL) AS pending,
           (SELECT COUNT(*)::int FROM eth_bridge_movements
             WHERE user_id = $1 AND status = 'refunded' AND invalidated_at IS NULL) AS refunded,
           (SELECT COUNT(*)::int FROM eth_bridge_movements
             WHERE user_id = $1 AND status = 'failed' AND invalidated_at IS NULL) AS failed,
           (SELECT COUNT(*)::int FROM eth_bridge_movements
             WHERE user_id = $1 AND status = 'unsupported' AND invalidated_at IS NULL) AS unsupported,
           (SELECT COUNT(*)::int FROM eth_bridge_suggestions s
             WHERE s.user_id = $1 AND NOT EXISTS (
               SELECT 1 FROM eth_bridge_verdicts v
                WHERE v.user_id = s.user_id
                  AND v.out_wallet_id = s.out_wallet_id AND v.out_chain_id = s.out_chain_id
                  AND v.out_tx_hash = s.out_tx_hash
                  AND v.in_wallet_id = s.in_wallet_id AND v.in_chain_id = s.in_chain_id
                  AND v.in_tx_hash = s.in_tx_hash
             )) AS suggestions,
           (SELECT COUNT(*)::int
              FROM (
                SELECT DISTINCT ON (a.wallet_id, a.chain_id, a.tx_hash) a.status
                  FROM eth_bridge_receipt_attempts a
                  JOIN eth_wallets w ON w.id = a.wallet_id
                 WHERE w.user_id = $1
                 ORDER BY a.wallet_id, a.chain_id, a.tx_hash, a.attempted_at DESC, a.id DESC
              ) latest
             WHERE latest.status IN ('failed', 'unsupported')) AS receipt_failures`,
        [userId]
      ),
    ]);
    return {
      movements: movements.rows,
      suggestions: suggestions.rows,
      verdicts: verdicts.rows,
      receipt_failures: receiptFailures.rows,
      summary: summary.rows[0],
    };
  }

  static async upsertVerdict(userId, input, client = pool) {
    if (!userId) throw new Error('Bridge verdict requires a user');
    const fields = [
      input.outWalletId, input.outChainId, lower(input.outTxHash),
      input.inWalletId, input.inChainId, lower(input.inTxHash),
    ];
    if (![fields[0], fields[1], fields[3], fields[4]].every((value) => Number.isInteger(Number(value)) && Number(value) > 0)
        || !HASH_RE.test(fields[2]) || !HASH_RE.test(fields[5])
        || !['confirmed', 'rejected'].includes(input.verdict)
        || Number(fields[1]) === Number(fields[4])) {
      const error = new Error('Invalid bridge verdict coordinates');
      error.code = 'INVALID_BRIDGE_VERDICT';
      throw error;
    }
    const { rows: activities } = await client.query(
      `SELECT a.wallet_id, a.chain_id, a.tx_hash,
              COALESCE(o.category, a.category) AS category
         FROM eth_activity a
         JOIN eth_wallets w ON w.id = a.wallet_id
         LEFT JOIN eth_activity_overrides o
           ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
        WHERE w.user_id = $1 AND (
          (a.wallet_id = $2 AND a.chain_id = $3 AND a.tx_hash = $4)
          OR (a.wallet_id = $5 AND a.chain_id = $6 AND a.tx_hash = $7)
        )`,
      [userId, ...fields]
    );
    const out = activities.find((row) => coordinate(row.wallet_id, row.chain_id, row.tx_hash)
      === coordinate(fields[0], fields[1], fields[2]));
    const incoming = activities.find((row) => coordinate(row.wallet_id, row.chain_id, row.tx_hash)
      === coordinate(fields[3], fields[4], fields[5]));
    if (!out || !incoming || out.category !== 'bridge_out' || incoming.category !== 'bridge_in') {
      const error = new Error('Bridge verdict must name one owned bridge_out and one owned bridge_in');
      error.code = 'BRIDGE_VERDICT_NOT_FOUND';
      throw error;
    }
    if (input.verdict === 'confirmed') {
      const { rows: conflicts } = await client.query(
        `SELECT id FROM eth_bridge_verdicts
          WHERE user_id = $1 AND verdict = 'confirmed'
            AND NOT (out_wallet_id = $2 AND out_chain_id = $3 AND out_tx_hash = $4
                     AND in_wallet_id = $5 AND in_chain_id = $6 AND in_tx_hash = $7)
            AND ((out_wallet_id = $2 AND out_chain_id = $3 AND out_tx_hash = $4)
              OR (in_wallet_id = $5 AND in_chain_id = $6 AND in_tx_hash = $7))
          LIMIT 1`,
        [userId, ...fields]
      );
      if (conflicts.length) {
        const error = new Error('Another confirmed bridge movement already claims one of these transactions');
        error.code = 'BRIDGE_VERDICT_CONFLICT';
        throw error;
      }
    }
    const { rows } = await client.query(
      `INSERT INTO eth_bridge_verdicts
         (user_id, out_wallet_id, out_chain_id, out_tx_hash,
          in_wallet_id, in_chain_id, in_tx_hash, verdict, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, out_wallet_id, out_chain_id, out_tx_hash,
                    in_wallet_id, in_chain_id, in_tx_hash) DO UPDATE SET
         verdict = EXCLUDED.verdict, note = EXCLUDED.note, updated_at = NOW()
       RETURNING *`,
      [userId, ...fields, input.verdict, input.note == null ? null : String(input.note).slice(0, 1000)]
    );
    return rows[0];
  }

  static async deleteVerdict(userId, input, client = pool) {
    const { rowCount } = await client.query(
      `DELETE FROM eth_bridge_verdicts
        WHERE user_id = $1
          AND out_wallet_id = $2 AND out_chain_id = $3 AND out_tx_hash = $4
          AND in_wallet_id = $5 AND in_chain_id = $6 AND in_tx_hash = $7`,
      [
        userId, input.outWalletId, input.outChainId, lower(input.outTxHash),
        input.inWalletId, input.inChainId, lower(input.inTxHash),
      ]
    );
    return rowCount;
  }
}

module.exports = EthBridgeMovement;
module.exports.coordinate = coordinate;
module.exports.projectionAmounts = projectionAmounts;
