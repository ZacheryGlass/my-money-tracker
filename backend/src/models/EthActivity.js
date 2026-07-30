'use strict';

const pool = require('../config/database');
const { DEFAULT_CHAIN_ID } = require('../config/chains');

// Every read resolves a manual CATEGORY override over the derived verdict in
// one place. A category override clears needs_review because it is a verdict;
// a note-only row does not, because prose can preserve uncertainty.
//
// The join is on the full key (wallet, chain, tx_hash), which both tables carry
// a UNIQUE index on, so it can never fan one activity row into two.
const RESOLVED_COLUMNS = `
    a.id, a.wallet_id, a.chain_id, a.tx_hash, a.block_number, a.block_time,
    COALESCE(o.category, a.category) AS category,
    a.category AS derived_category,
    o.category AS override_category,
    o.note AS override_note,
    (o.category IS NOT NULL) AS is_overridden,
    a.counterparty_address, a.counterparty_name,
    a.method_id, a.method_name,
    a.legs, a.fee_wei, a.confidence, a.classified_at,
    -- At-the-time USD (043). Derived alongside the legs and rebuilt with them,
    -- so an override changes what a transaction MEANS without touching what it
    -- was worth: the dollars are a market fact, the category is a judgment.
    a.usd_value, a.usd_fee, a.usd_basis,
    -- The spam quarantine (045), resolved the same way the category is: the
    -- user's verdict wins, and NULL means they have not given one. A row can be
    -- un-quarantined (FALSE over a derived TRUE) or hand-quarantined (TRUE over
    -- a derived FALSE); both survive the wholesale rebuild because they live on
    -- the overrides table.
    COALESCE(o.spam, a.spam) AS spam,
    a.spam AS derived_spam,
    o.spam AS override_spam,
    -- WHICH heuristic fired, kept even when the user overrode it -- "we thought
    -- this was poisoning and you disagreed" is the only way the verdict is
    -- auditable. A reason code, not prose; see 045.
    a.spam_reason,
    -- needs_review is stored as the LADDER's honest answer and masked here.
    -- Masking rather than clearing at build time is what makes an un-quarantine
    -- lossless: a false positive comes back to the queue instead of arriving
    -- silently marked reviewed. An override of the category still clears it --
    -- an override IS a review -- but a spam verdict is not a category verdict.
    CASE WHEN o.category IS NOT NULL OR COALESCE(o.spam, a.spam) THEN FALSE
         ELSE a.needs_review END AS needs_review,
    CASE WHEN o.category IS NOT NULL OR COALESCE(o.spam, a.spam) THEN NULL
         ELSE a.review_reason END AS review_reason,
    w.address AS wallet_address,
    -- The exchange's own record of this same movement (#61), or NULL when
    -- nothing matched. Carries the venue's fee_asset/fee_amount because that is
    -- the WITHDRAWAL fee: it is charged off-chain, so fee_wei (gas) does not
    -- contain it and the on-chain legs never will.
    CASE WHEN em.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', em.id,
      'exchange_record_id', em.exchange_record_id,
      'match_method', em.match_method,
      'confidence', em.confidence,
      'exchange_account_id', mea.id,
      'exchange_account_name', mea.name,
      'exchange', mea.exchange,
      'record_type', mer.record_type,
      'occurred_at', mer.occurred_at,
      'base_asset', mer.base_asset,
      'base_amount', mer.base_amount,
      'fee_asset', mer.fee_asset,
      'fee_amount', mer.fee_amount,
      'verdict', mv.verdict
    ) END AS exchange_match,
    -- The cross-chain pairing (#59). A matched pair IS one movement of the
    -- user's own money, so each leg carries the other's coordinates and the
    -- fee the bridge took, and the two render as a single self-transfer.
    -- Both link columns are UNIQUE, so neither join can fan a row out.
    COALESCE(lo.id, li.id) AS bridge_link_id,
    COALESCE(lo.asset, li.asset) AS bridge_asset,
    COALESCE(lo.out_amount, li.out_amount) AS bridge_out_amount,
    COALESCE(lo.in_amount, li.in_amount) AS bridge_in_amount,
    COALESCE(lo.fee_amount, li.fee_amount) AS bridge_fee_amount,
    COALESCE(lo.asset_details, li.asset_details) AS bridge_asset_details,
    pair.chain_id AS bridge_counterpart_chain_id,
    pair.tx_hash AS bridge_counterpart_tx_hash,
    pair.category AS bridge_counterpart_category`;

const RESOLVED_FROM = `
    FROM eth_activity a
    JOIN eth_wallets w ON w.id = a.wallet_id
    LEFT JOIN eth_activity_overrides o
      ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
    -- At most one match per activity row (041's unique index says so), so none
    -- of these can fan one row into two.
    LEFT JOIN exchange_matches em ON em.activity_id = a.id
    LEFT JOIN exchange_records mer ON mer.id = em.exchange_record_id
    LEFT JOIN exchange_accounts mea ON mea.id = mer.exchange_account_id
    LEFT JOIN exchange_match_verdicts mv
      ON mv.exchange_record_id = em.exchange_record_id
     AND mv.counter_record_id IS NULL
     AND mv.wallet_id = a.wallet_id
     AND mv.chain_id = a.chain_id
     AND mv.tx_hash = a.tx_hash
    LEFT JOIN eth_activity_links lo ON lo.out_activity_id = a.id
    LEFT JOIN eth_activity_links li ON li.in_activity_id = a.id
    LEFT JOIN eth_activity pair ON pair.id = COALESCE(lo.in_activity_id, li.out_activity_id)`;

const INSERT_COLUMNS = [
  'wallet_id', 'chain_id', 'tx_hash', 'block_number', 'block_time', 'category',
  'counterparty_address', 'counterparty_name', 'method_id', 'method_name',
  'legs', 'fee_wei', 'needs_review', 'review_reason', 'confidence',
  // Appended, never inserted mid-list: `legs` needs its ::jsonb cast and the
  // placeholder builder below finds it by index.
  'usd_value', 'usd_fee', 'usd_basis',
  'spam', 'spam_reason',
];

// The one column that needs a cast, found by name rather than by a hardcoded
// ordinal -- appending a column used to silently move the cast onto the wrong
// placeholder.
const LEGS_COLUMN_INDEX = INSERT_COLUMNS.indexOf('legs');

class EthActivity {
  // Delete-then-insert, like the ledger mirror. Scoped to eth_activity ONLY:
  // eth_activity_overrides is never touched here, which is what makes a manual
  // correction survive every resync and every relabel.
  static async replaceForWallet(walletId, rows) {
    await pool.query('DELETE FROM eth_activity WHERE wallet_id = $1', [walletId]);
    if (!rows.length) return 0;

    const CHUNK = 200;
    let inserted = 0;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values = [];
      const placeholders = chunk.map((row, i) => {
        const base = i * INSERT_COLUMNS.length;
        // 045's paired CHECK refuses a quarantine with no reason and a reason
        // with no quarantine. Both columns are derived from ONE value here, so
        // a caller that got them out of step cannot abort a whole insert chunk
        // -- and cannot hide a row without saying why, which is the half of
        // that constraint that actually matters.
        const spamReason = row.spam === true ? (row.spam_reason ?? null) : null;
        values.push(
          walletId,
          row.chain_id ?? DEFAULT_CHAIN_ID,
          row.tx_hash,
          row.block_number,
          row.block_time,
          row.category,
          row.counterparty_address ?? null,
          row.counterparty_name ?? null,
          row.method_id ?? null,
          row.method_name ?? null,
          JSON.stringify(row.legs ?? []),
          row.fee_wei ?? '0',
          row.needs_review === true,
          row.review_reason ?? null,
          row.confidence || 'high',
          // NULL is UNPRICED, never 0: a transaction whose asset had no close
          // on its date is not a transaction worth nothing.
          row.usd_value ?? null,
          row.usd_fee ?? null,
          row.usd_basis ?? null,
          spamReason != null,
          spamReason
        );
        return `(${INSERT_COLUMNS.map((_, j) => (j === LEGS_COLUMN_INDEX ? `$${base + j + 1}::jsonb` : `$${base + j + 1}`)).join(', ')})`;
      });
      const result = await pool.query(
        `INSERT INTO eth_activity (${INSERT_COLUMNS.join(', ')})
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (wallet_id, chain_id, tx_hash) DO NOTHING`,
        values
      );
      inserted += result.rowCount;
    }
    return inserted;
  }

  // The activity feed. Covers every wallet the user owns; walletId narrows
  // within that set and never widens it. Fail-closed: an unscoped read throws
  // rather than serving one user's chain history to another.
  // `spam` is three-valued and DEFAULTS TO EXCLUDING quarantined rows (#74):
  //   'exclude' (default) the ledger as a person wants to read it
  //   'only'                the Spam filter -- what was quarantined, and why
  //   'all'                 both, for a caller that wants the full history
  // Excluding by default is the point of a quarantine, and the honest half of
  // it is that `total` then reports the FILTERED count, so a caller can never
  // mistake a hidden row for a missing one -- ask for 'only' and it is there.
  static async findForUser(userId, { walletId = null, category = null, needsReview = null, spam = 'exclude', limit = 100, offset = 0 } = {}) {
    if (!userId) throw new Error('EthActivity.findForUser requires a userId');
    const params = [userId];
    // Filters apply to the RESOLVED values, not the derived ones: a
    // transaction the user re-categorized has to answer to the category they
    // chose, and must not still show up under needs_review -- and one the user
    // un-quarantined has to come back to the default feed.
    let where = 'WHERE TRUE';
    if (spam === 'only') where += ' AND r.spam';
    else if (spam !== 'all') where += ' AND NOT r.spam';
    if (walletId != null) {
      params.push(walletId);
      where += ` AND r.wallet_id = $${params.length}`;
    }
    if (category) {
      params.push(category);
      where += ` AND r.category = $${params.length}`;
    }
    if (needsReview !== null) {
      params.push(needsReview);
      where += ` AND r.needs_review = $${params.length}`;
    }
    params.push(limit, offset);

    const result = await pool.query(
      `WITH resolved AS (
         SELECT ${RESOLVED_COLUMNS}
         ${RESOLVED_FROM}
         WHERE w.user_id = $1
       )
       SELECT r.*, COUNT(*) OVER() AS total_count
       FROM resolved r
       ${where}
       -- block_number is a PER-CHAIN sequence since 039, so time is the only
       -- order that interleaves a multi-chain feed correctly. tx_hash then id
       -- close the ordering -- none of the leading keys is unique in a merged
       -- feed (two of the user's own wallets both see an A->B self-send, same
       -- time, same hash), and a non-total ORDER BY lets LIMIT/OFFSET repeat
       -- one row on page 2 and drop the other entirely.
       ORDER BY r.block_time DESC, r.block_number DESC, r.tx_hash DESC, r.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return {
      activity: result.rows.map((row) => {
        const rest = { ...row };
        delete rest.total_count;
        return rest;
      }),
      total,
    };
  }

  // Scalar counts for the "no transaction unexplained" badge (#63 renders it).
  //
  // needs_review is already masked for quarantined rows by RESOLVED_COLUMNS, so
  // a wave of scam airdrops cannot move this badge -- which is the whole reason
  // #74 exists: a badge that cannot reach zero gets ignored, and takes the real
  // flags with it. The quarantine gets its OWN count instead of being invisible;
  // hiding rows without saying how many is the failure a quarantine must not
  // have.
  //
  // `walletId` narrows it to one wallet and never widens it, matching the feed:
  // a headline count that totals every wallet above wallet-filtered rows is a
  // number nobody can reconcile with what they are looking at -- and for a
  // quarantine the count IS the honesty guarantee, so it has to be about the
  // rows on screen.
  static async summaryForUser(userId, { walletId = null } = {}) {
    if (!userId) throw new Error('EthActivity.summaryForUser requires a userId');
    const params = [userId];
    let scope = '';
    if (walletId != null) {
      params.push(walletId);
      scope = ` AND a.wallet_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total,
              (COUNT(*) FILTER (WHERE needs_review))::int AS needs_review_count,
              (COUNT(*) FILTER (WHERE spam))::int AS spam_count
       FROM (SELECT ${RESOLVED_COLUMNS} ${RESOLVED_FROM} WHERE w.user_id = $1${scope}) resolved`,
      params
    );
    const row = result.rows[0] || {};
    return {
      total: Number(row.total) || 0,
      needsReviewCount: Number(row.needs_review_count) || 0,
      spamCount: Number(row.spam_count) || 0,
    };
  }

  // Does the user own an activity row for this exact key? An override that
  // targets nothing is invisible forever -- every reader joins activity ->
  // override, so a correction written against a hash this wallet never saw is
  // stored and never rendered. Fail-closed like every other scoped read.
  static async overrideTargetExists(userId, walletId, txHash, { chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.overrideTargetExists requires a userId');
    const result = await pool.query(
      `SELECT 1 FROM eth_activity a
       JOIN eth_wallets w ON w.id = a.wallet_id
       WHERE a.wallet_id = $1 AND a.chain_id = $2 AND a.tx_hash = $3 AND w.user_id = $4
       LIMIT 1`,
      [walletId, chainId, txHash, userId]
    );
    return result.rows.length > 0;
  }

  // The wallet join IS the ownership check: a foreign wallet id selects no row,
  // so the INSERT writes nothing and the caller gets null. The route checks
  // ownership too -- this is the half that holds if anything ever calls the
  // model directly.
  static async upsertOverride(userId, walletId, txHash, { category, note, chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.upsertOverride requires a userId');
    const noteProvided = note !== undefined;
    const result = await pool.query(
      `INSERT INTO eth_activity_overrides (wallet_id, chain_id, tx_hash, category, note, spam)
       SELECT w.id, $2, $3, $4, $5, FALSE
       FROM eth_wallets w
       WHERE w.id = $1 AND w.user_id = $6
       ON CONFLICT (wallet_id, chain_id, tx_hash)
       -- Naming a category LIFTS the quarantine, and that is not a coupling
       -- accident. A quarantine is "you do not need to look at this"; the user
       -- looking at it and saying what it was settles the question in the other
       -- direction. Leaving the flag alone let a correction be stored, acted on
       -- by the exchange matcher, and stay invisible -- with the row's own
       -- needs_review masked by the quarantine it still carried.
       --
       -- One click re-quarantines it if that is genuinely what they meant.
       DO UPDATE SET category = EXCLUDED.category,
                     note = CASE WHEN $7 THEN EXCLUDED.note ELSE eth_activity_overrides.note END,
                     spam = FALSE,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [walletId, chainId, txHash, category, noteProvided ? note : null, userId, noteProvided]
    );
    return result.rows[0] || null;
  }

  // Prose is not a verdict. A note-only row preserves the ladder's category,
  // needs_review flag and spam answer; if another override already exists this
  // changes only its note. Clearing the last remaining field removes the row
  // so migration 049's not-empty invariant remains true.
  static async setNote(userId, walletId, txHash, { note, chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.setNote requires a userId');
    const normalized = typeof note === 'string' && note.trim() ? note.trim() : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let row = null;
      if (normalized) {
        const result = await client.query(
          `INSERT INTO eth_activity_overrides (wallet_id, chain_id, tx_hash, note)
           SELECT w.id, $2, $3, $4
           FROM eth_wallets w
           WHERE w.id = $1 AND w.user_id = $5
           ON CONFLICT (wallet_id, chain_id, tx_hash)
           DO UPDATE SET note = EXCLUDED.note, updated_at = CURRENT_TIMESTAMP
           RETURNING *`,
          [walletId, chainId, txHash, normalized, userId]
        );
        row = result.rows[0] || null;
      } else {
        // Delete a note-only row directly. Updating it to NULL first would
        // violate the table's not-empty CHECK before a following DELETE could
        // run; constraints are checked per statement, not at COMMIT.
        const deleted = await client.query(
          `DELETE FROM eth_activity_overrides o
           USING eth_wallets w
           WHERE o.wallet_id = w.id
             AND w.user_id = $4
             AND o.wallet_id = $1
             AND o.chain_id = $2
             AND o.tx_hash = $3
             AND o.note IS NOT NULL
             AND o.category IS NULL
             AND o.spam IS NULL
           RETURNING o.*`,
          [walletId, chainId, txHash, userId]
        );
        const result = deleted.rows.length ? deleted : await client.query(
          `UPDATE eth_activity_overrides o
           SET note = NULL, updated_at = CURRENT_TIMESTAMP
           FROM eth_wallets w
           WHERE o.wallet_id = w.id
             AND w.user_id = $4
             AND o.wallet_id = $1
             AND o.chain_id = $2
             AND o.tx_hash = $3
             AND o.note IS NOT NULL
             AND (o.category IS NOT NULL OR o.spam IS NOT NULL)
           RETURNING o.*`,
          [walletId, chainId, txHash, userId]
        );
        row = result.rows[0] || null;
      }
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // The one-click un-quarantine, and its inverse.
  //
  // Writes ONLY the spam column, leaving any category override intact for the
  // same reason upsertOverride leaves this one alone. On insert the category is
  // NULL, which readers COALESCE away -- so "not spam" restores the row exactly
  // as the ladder classified it rather than re-labelling it, and un-masks the
  // ladder's needs_review with it. That is what "restores the row" has to mean:
  // a false positive that came back as a bare `receive` with the flag already
  // cleared would be a second, quieter way to lose it.
  static async setSpamOverride(userId, walletId, txHash, { spam, chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.setSpamOverride requires a userId');
    if (typeof spam !== 'boolean') throw new Error('EthActivity.setSpamOverride requires a boolean spam verdict');
    const result = await pool.query(
      `INSERT INTO eth_activity_overrides (wallet_id, chain_id, tx_hash, spam)
       SELECT w.id, $2, $3, $4
       FROM eth_wallets w
       WHERE w.id = $1 AND w.user_id = $5
       ON CONFLICT (wallet_id, chain_id, tx_hash)
       DO UPDATE SET spam = EXCLUDED.spam,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [walletId, chainId, txHash, spam, userId]
    );
    return result.rows[0] || null;
  }

  // A correction the user regrets has to be undoable, or the override is the
  // one-way door the derived table was designed not to be. Deleting it simply
  // uncovers the derived verdict again.
  static async deleteOverride(userId, walletId, txHash, { chainId = DEFAULT_CHAIN_ID } = {}) {
    if (!userId) throw new Error('EthActivity.deleteOverride requires a userId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same constraint boundary as setNote: delete a correction with no note
      // directly; only UPDATE rows whose note will keep them non-empty.
      const deleted = await client.query(
        `DELETE FROM eth_activity_overrides o
         USING eth_wallets w
         WHERE o.wallet_id = w.id
           AND w.user_id = $4
           AND o.wallet_id = $1
           AND o.chain_id = $2
           AND o.tx_hash = $3
           AND o.category IS NOT NULL
           AND o.note IS NULL
         RETURNING o.*`,
        [walletId, chainId, txHash, userId]
      );
      const result = deleted.rows.length ? deleted : await client.query(
        `UPDATE eth_activity_overrides o
         SET category = NULL, spam = NULL, updated_at = CURRENT_TIMESTAMP
         FROM eth_wallets w
         WHERE o.wallet_id = w.id
           AND w.user_id = $4
           AND o.wallet_id = $1
           AND o.chain_id = $2
           AND o.tx_hash = $3
           AND o.category IS NOT NULL
           AND o.note IS NOT NULL
         RETURNING o.*`,
        [walletId, chainId, txHash, userId]
      );
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = EthActivity;
module.exports.DEFAULT_CHAIN_ID = DEFAULT_CHAIN_ID;
