'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const { DEFAULT_CHAIN_ID } = require('../config/chains');

// Every read here is fail-closed and scoped through a ROOT table -- eth_wallets
// for the on-chain side, exchange_accounts for the exchange side. exchange_
// matches itself carries no user_id: it is derived, and denormalizing ownership
// onto a derived table is how the two copies drift.
function requireUserId(method, userId) {
  if (!userId) {
    throw new Error(`ExchangeMatch.${method} requires a userId`);
  }
}

// Relative slack on top of the exchange's own fee, as an exact NUMERIC literal.
// A withdrawal's on-chain amount and its ledger amount differ by the network
// fee, and the two sides do not agree on whether that fee is inside or outside
// the figure -- so the fee is added to the tolerance rather than subtracted
// from one side. The extra 0.5% covers an exchange that rounds its display
// amount; it is small enough that two genuinely different transfers of the same
// asset would have to be within half a percent of each other to collide.
const AMOUNT_TOLERANCE_RATE = '0.005';

// How far apart the two sides may sit. An exchange credits a deposit after N
// confirmations and processes a withdrawal out of a queue, so "hours" is the
// right unit -- the issue says so. Wide enough for a slow queue, narrow enough
// that a repeated monthly transfer of the same size cannot cross into it.
const MATCH_WINDOW_HOURS = 24;

// Money leaves the sending exchange before it lands at the receiving one, so
// the deposit is expected AFTER the withdrawal. The backward slack exists only
// because the two venues stamp their own clocks.
const PAIR_BACKDATE_HOURS = 1;

// The exchange-side rows that can be half of a movement. A trade or a reward
// never has an on-chain counterpart, and letting them into the candidate set
// would let a reward of the same size stand in for a deposit.
const MATCHABLE_RECORD_TYPES = ['deposit', 'withdrawal'];

const INSERT_COLUMNS = [
  'exchange_record_id', 'activity_id', 'counter_record_id', 'match_method', 'confidence',
];

// One activity row's netted movement, pulled out of legs JSONB.
//
// Restricted to a SINGLE net leg on purpose: an exchange transfer moves exactly
// one asset, so a row with two net legs is a swap or something stranger and has
// no business fallback-matching against a one-asset record. The hash arm does
// not read these at all -- a hash is identity, whatever the legs look like.
const ACTIVITY_LEG = `
    CASE WHEN jsonb_array_length(a.legs) = 1 THEN UPPER(a.legs->0->>'asset') END AS leg_asset,
    CASE WHEN jsonb_array_length(a.legs) = 1 THEN (a.legs->0->>'amount')::numeric END AS leg_amount,
    CASE WHEN jsonb_array_length(a.legs) = 1 THEN a.legs->0->>'direction' END AS leg_direction`;

// The activity side of every matching query. `category` is the RESOLVED one --
// override coalesced over derived -- for the same reason every other reader
// coalesces: a transaction the user re-categorized as an exchange deposit has
// to be matchable as one, and one they corrected AWAY from that must stop
// being matched as one.
const SCOPED_ACTIVITY = `
  scoped_activity AS (
    SELECT a.id AS activity_id, a.wallet_id, a.chain_id, LOWER(a.tx_hash) AS tx_hash,
           a.block_time, LOWER(a.counterparty_address) AS counterparty_address,
           LOWER(w.address) AS wallet_address,
           COALESCE(o.category, a.category) AS category,
           -- Whether counterparty_address is the transfer's real other side. A
           -- row with several net legs (or none) falls back to the GAS leg's
           -- to_address, which for a swap is a router contract -- true of the
           -- transaction, useless as a venue identity. The learning loop reads
           -- this and refuses to label anything else.
           (jsonb_array_length(a.legs) = 1) AS single_net_leg,
           ${ACTIVITY_LEG}
    FROM eth_activity a
    JOIN eth_wallets w ON w.id = a.wallet_id
    LEFT JOIN eth_activity_overrides o
      ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
    WHERE w.user_id = $1
  )`;

// The exchange side. Amounts are stored SIGNED as the venue wrote them (a
// withdrawal is negative), and every comparison below is about magnitude, so
// they are made absolute once here rather than at each use.
const SCOPED_RECORDS = `
  scoped_records AS (
    SELECT er.id AS record_id, er.exchange_account_id, ea.name AS exchange_account_name,
           er.record_type, er.occurred_at,
           UPPER(er.base_asset) AS base_asset, ABS(er.base_amount) AS base_amount,
           -- The fee widens a BASE-ASSET tolerance, so only a fee denominated in
           -- the base asset may be added to it. Coinbase retail books a
           -- withdrawal fee in the price currency (USD), and adding "12.34" to a
           -- tolerance measured in ETH turns a half-percent window into twelve
           -- ether -- which matched a 3.5 ETH transfer against a 2 ETH record.
           -- A foreign-currency fee is not converted (no rate is stored on the
           -- row); it is simply dropped, leaving the 0.5% relative slack, which
           -- is what covers a rounded display amount anyway.
           CASE WHEN er.fee_asset IS NULL OR UPPER(er.fee_asset) = UPPER(er.base_asset)
                THEN COALESCE(ABS(er.fee_amount), 0) ELSE 0 END AS base_fee_amount,
           LOWER(er.tx_hash) AS tx_hash, LOWER(er.address) AS address,
           er.network, er.chain_id
    FROM exchange_records er
    JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
    WHERE ea.user_id = $1
      AND er.record_type = ANY($4::varchar[])
      AND er.base_amount IS NOT NULL
      AND er.base_asset IS NOT NULL
  )`;

// Both sides of a match, described well enough for a feed row to render
// without a second round trip.
const MATCH_COLUMNS = `
    m.id, m.exchange_record_id, m.activity_id, m.counter_record_id,
    m.match_method, m.confidence, m.matched_at,
    er.record_type, er.occurred_at, er.base_asset, er.base_amount,
    er.fee_asset, er.fee_amount, er.tx_hash AS record_tx_hash, er.address AS record_address,
    er.network AS record_network, er.chain_id AS record_chain_id,
    ea.id AS exchange_account_id, ea.name AS exchange_account_name, ea.exchange,
    counter.record_type AS counter_record_type, counter.occurred_at AS counter_occurred_at,
    counter.base_asset AS counter_base_asset, counter.base_amount AS counter_base_amount,
    counter_account.id AS counter_account_id, counter_account.name AS counter_account_name,
    a.wallet_id, a.chain_id, a.tx_hash, a.block_time, a.category, a.legs, a.fee_wei,
    w.address AS wallet_address,
    v.verdict, v.note AS verdict_note`;

const MATCH_FROM = `
    FROM exchange_matches m
    JOIN exchange_records er ON er.id = m.exchange_record_id
    JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
    LEFT JOIN exchange_records counter ON counter.id = m.counter_record_id
    LEFT JOIN exchange_accounts counter_account ON counter_account.id = counter.exchange_account_id
    LEFT JOIN eth_activity a ON a.id = m.activity_id
    LEFT JOIN eth_wallets w ON w.id = a.wallet_id
    LEFT JOIN exchange_match_verdicts v
      ON v.exchange_record_id = m.exchange_record_id
     AND v.counter_record_id IS NOT DISTINCT FROM m.counter_record_id
     AND v.wallet_id IS NOT DISTINCT FROM a.wallet_id
     AND v.chain_id IS NOT DISTINCT FROM a.chain_id
     AND v.tx_hash IS NOT DISTINCT FROM a.tx_hash`;

class ExchangeMatch {
  static get AMOUNT_TOLERANCE_RATE() { return AMOUNT_TOLERANCE_RATE; }
  static get MATCH_WINDOW_HOURS() { return MATCH_WINDOW_HOURS; }
  static get PAIR_BACKDATE_HOURS() { return PAIR_BACKDATE_HOURS; }
  static get MATCHABLE_RECORD_TYPES() { return MATCHABLE_RECORD_TYPES; }

  /**
   * Every (activity, exchange record) pair that COULD be the same movement.
   *
   * Two arms, and the difference between them is the difference between proof
   * and inference:
   *
   *  - tx_hash. The exchange published the on-chain hash of the transfer, so
   *    this is identity, not a guess. exchange_records has no chain column
   *    while eth_activity is chain-keyed (039), which makes a stored hash
   *    chain-AMBIGUOUS -- but a 32-byte hash is not reproduced by accident, and
   *    old rows can still have no chain, but a source-backed chain id narrows
   *    the join and prevents a cross-chain replay from claiming the wrong leg.
   *
   *  - asset + amount + window, for the records that carry no hash (a Kraken
   *    ledgers CSV has neither a txid nor a destination). Restricted to
   *    activities the ladder already called an exchange flow: the heuristic is
   *    weak enough that letting it loose on every send would invent pairings.
   *
   * Direction is enforced on both arms. On-chain `exchange_deposit` means value
   * LEFT the wallet for the venue, which the venue records as a DEPOSIT; the
   * mirror image for a withdrawal. Without that, a deposit and a withdrawal of
   * the same size on the same day match each other.
   */
  static async onChainCandidates(userId) {
    requireUserId('onChainCandidates', userId);
    const result = await pool.query(
      `WITH ${SCOPED_ACTIVITY},
       ${SCOPED_RECORDS}
       SELECT sa.activity_id, sr.record_id AS exchange_record_id,
              sa.wallet_id, sa.chain_id, sa.tx_hash, sa.counterparty_address,
              sa.single_net_leg, sr.exchange_account_name,
              'tx_hash' AS match_method, 'high' AS confidence, 0::bigint AS time_delta
       FROM scoped_activity sa
       JOIN scoped_records sr
         ON sr.tx_hash = sa.tx_hash
        AND (sr.chain_id IS NULL OR sr.chain_id = sa.chain_id)
       -- A row with no single net leg (a revert, a multi-asset call) has no
       -- direction to check; the hash already settled identity.
       WHERE sa.leg_direction IS NULL
          OR sr.record_type = CASE WHEN sa.leg_direction = 'out' THEN 'deposit' ELSE 'withdrawal' END

       UNION ALL

       SELECT sa.activity_id, sr.record_id,
              sa.wallet_id, sa.chain_id, sa.tx_hash, sa.counterparty_address,
              sa.single_net_leg, sr.exchange_account_name,
              -- The record's stored address being one of the two addresses in
              -- the transfer is real corroboration: a withdrawal names its
              -- destination (this wallet) and a deposit names the venue's
              -- deposit address (this counterparty).
              CASE WHEN sr.address IS NOT NULL
                    AND sr.address IN (sa.wallet_address, sa.counterparty_address)
                   THEN 'address_amount' ELSE 'amount_window' END,
              'medium',
              EXTRACT(EPOCH FROM (GREATEST(sa.block_time, sr.occurred_at)
                                  - LEAST(sa.block_time, sr.occurred_at)))::bigint
       FROM scoped_activity sa
       JOIN scoped_records sr
         ON sr.tx_hash IS NULL
        AND (sr.chain_id IS NULL OR sr.chain_id = sa.chain_id)
        -- DEFERRED: raw symbol equality. WETH and stETH read as different
        -- assets from the ETH the venue recorded (false negatives), and a spam
        -- token minted with a real ticker reads as the same one (false
        -- positives) -- the latter only mitigated by this arm requiring an
        -- already-exchange_* category, which needs an exchange LABEL on the
        -- counterparty. A canonical-asset map is the fix and is out of scope
        -- here; nothing below depends on the comparison staying naive.
        AND sr.base_asset = sa.leg_asset
        AND sr.record_type = CASE WHEN sa.category = 'exchange_deposit' THEN 'deposit' ELSE 'withdrawal' END
        -- Exact NUMERIC throughout. These are wei-scale quantities and a
        -- float comparison would both miss real matches and invent fake ones.
        -- base_fee_amount, never the raw fee: a fee in another currency is not
        -- a quantity of this asset (see scoped_records).
        AND ABS(sr.base_amount - sa.leg_amount) <= sr.base_fee_amount + sa.leg_amount * $2::numeric
        AND sa.block_time >= sr.occurred_at - make_interval(hours => $3::int)
        AND sa.block_time <= sr.occurred_at + make_interval(hours => $3::int)
       WHERE sa.category IN ('exchange_deposit', 'exchange_withdrawal')
         AND sa.leg_asset IS NOT NULL
         AND sa.leg_amount IS NOT NULL`,
      [userId, AMOUNT_TOLERANCE_RATE, MATCH_WINDOW_HOURS, MATCHABLE_RECORD_TYPES]
    );
    return result.rows;
  }

  /**
   * Withdrawal on one account paired with the deposit it produced on another --
   * a movement with no user-owned on-chain leg at all, so nothing in
   * eth_activity can ever explain it.
   *
   * Different accounts is the whole condition: a withdrawal and a deposit on
   * the SAME account are two unrelated movements that happen to be the same
   * size, and pairing them would delete both from the history.
   */
  static async exchangePairCandidates(userId) {
    requireUserId('exchangePairCandidates', userId);
    const result = await pool.query(
      `WITH ${SCOPED_RECORDS}
       SELECT sent.record_id AS exchange_record_id, received.record_id AS counter_record_id,
              CASE
                WHEN sent.tx_hash IS NOT NULL AND sent.tx_hash = received.tx_hash THEN 'tx_hash'
                WHEN sent.address IS NOT NULL AND sent.address = received.address THEN 'address_amount'
                ELSE 'amount_window'
              END AS match_method,
              CASE WHEN sent.tx_hash IS NOT NULL AND sent.tx_hash = received.tx_hash
                   THEN 'high' ELSE 'medium' END AS confidence,
              EXTRACT(EPOCH FROM (GREATEST(sent.occurred_at, received.occurred_at)
                                  - LEAST(sent.occurred_at, received.occurred_at)))::bigint AS time_delta
       FROM scoped_records sent
       JOIN scoped_records received
         ON received.exchange_account_id <> sent.exchange_account_id
        AND sent.record_type = 'withdrawal'
        AND received.record_type = 'deposit'
        -- Raw symbol equality again, deferred for the same reasons as the
        -- on-chain arm: WETH/stETH are false negatives, a spoofed ticker a
        -- false positive.
        AND sent.base_asset = received.base_asset
        AND (sent.chain_id IS NULL OR received.chain_id IS NULL
             OR sent.chain_id = received.chain_id)
        AND (
          (sent.tx_hash IS NOT NULL AND sent.tx_hash = received.tx_hash)
          OR (
            ABS(sent.base_amount - received.base_amount)
              <= sent.base_fee_amount + received.base_fee_amount + sent.base_amount * $2::numeric
            AND received.occurred_at >= sent.occurred_at - make_interval(hours => $5::int)
            AND received.occurred_at <= sent.occurred_at + make_interval(hours => $3::int)
          )
        )`,
      [userId, AMOUNT_TOLERANCE_RATE, MATCH_WINDOW_HOURS, MATCHABLE_RECORD_TYPES, PAIR_BACKDATE_HOURS]
    );
    return result.rows;
  }

  /**
   * The user's confirm/reject answers, with the on-chain side resolved to a
   * live activity id.
   *
   * The LEFT JOIN is what makes a stored verdict survive: it is keyed on
   * (wallet, chain, tx_hash), so the surrogate id it resolves to today is
   * whatever the last rebuild happened to write. A verdict whose transaction
   * is not currently in eth_activity resolves to NULL and is simply inert
   * until the row comes back.
   */
  static async verdictsForUser(userId) {
    requireUserId('verdictsForUser', userId);
    const result = await pool.query(
      `SELECT v.id, v.exchange_record_id, v.counter_record_id, v.verdict, v.note,
              v.wallet_id, v.chain_id, v.tx_hash, a.id AS activity_id
       FROM exchange_match_verdicts v
       JOIN exchange_records er ON er.id = v.exchange_record_id
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       LEFT JOIN eth_activity a
         ON a.wallet_id = v.wallet_id AND a.chain_id = v.chain_id AND a.tx_hash = v.tx_hash
        -- Fail closed on the on-chain side too. The verdict row is reached
        -- through the record's account, which says nothing about the wallet id
        -- stored on it; without this a verdict carrying a foreign wallet_id
        -- would resolve to that user's activity row and match against it.
        AND EXISTS (SELECT 1 FROM eth_wallets w WHERE w.id = a.wallet_id AND w.user_id = $1)
       WHERE ea.user_id = $1`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Delete-then-insert, scoped to this user's records. Same contract as
   * EthActivity.replaceForWallet: the derived table is rebuilt in full and the
   * verdict table is never touched.
   */
  static async replaceForUser(userId, rows) {
    requireUserId('replaceForUser', userId);

    // One transaction, following ExchangeRecord.bulkUpsert. Delete-then-insert
    // outside one is a window in which this user has NO matches at all, and a
    // failure mid-insert leaves that window open permanently.
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM exchange_matches m
         USING exchange_records er
         JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
         WHERE m.exchange_record_id = er.id AND ea.user_id = $1`,
        [userId]
      );

      const CHUNK = 200;
      for (let start = 0; start < rows.length; start += CHUNK) {
        const chunk = rows.slice(start, start + CHUNK);
        const values = [];
        const placeholders = chunk.map((row, i) => {
          const base = i * INSERT_COLUMNS.length;
          values.push(
            row.exchange_record_id,
            row.activity_id ?? null,
            row.counter_record_id ?? null,
            row.match_method,
            row.confidence || 'medium'
          );
          return `(${INSERT_COLUMNS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
        });
        const result = await client.query(
          `INSERT INTO exchange_matches (${INSERT_COLUMNS.join(', ')})
           VALUES ${placeholders.join(', ')}
           ON CONFLICT DO NOTHING`,
          values
        );
        inserted += result.rowCount || 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.warn({ err: rollbackError, userId }, 'Exchange match rebuild rollback failed');
      }
      throw err;
    } finally {
      client.release();
    }

    // DO NOTHING is a safety net, not a plan: selectMatches already enforces
    // one claim per record and per activity, so a conflict here means the two
    // disagree. Silently keeping fewer matches than were derived is how that
    // disagreement would stay invisible.
    if (inserted !== rows.length) {
      logger.warn(
        { userId, derived: rows.length, inserted, dropped: rows.length - inserted },
        'Exchange match insert dropped rows on conflict'
      );
    }
    return inserted;
  }

  /**
   * A matched transfer IS explained, so it leaves the review queue -- and it
   * carries the match's confidence, not the ladder's: a transfer paired by
   * hash is certain, one paired by amount and a time window is not.
   *
   * Only ever clears a flag; it cannot set one, which is what keeps this from
   * fighting with flagUnmatchedExchangeFlows.
   *
   * PATH-INDEPENDENT: the confidence is stamped on every matched row, not only
   * on rows that happen to be flagged right now. Gating on needs_review made
   * the stored answer depend on history -- a transfer synced BEFORE its record
   * was imported was flagged, then cleared to the match's 'medium'; the same
   * transfer synced after already had the record, was never flagged, and kept
   * the ladder's 'high'. Identical data, two answers. The extra predicate keeps
   * the statement from rewriting rows that already say the right thing, so
   * `cleared` still counts real changes and a no-op rebuild writes nothing.
   */
  static async clearReviewForMatched(userId) {
    requireUserId('clearReviewForMatched', userId);
    const result = await pool.query(
      `UPDATE eth_activity a
       SET needs_review = FALSE, review_reason = NULL, confidence = m.confidence
       FROM eth_wallets w, exchange_matches m
       WHERE w.id = a.wallet_id AND w.user_id = $1
         AND m.activity_id = a.id
         AND (a.needs_review
              OR a.review_reason IS NOT NULL
              OR a.confidence IS DISTINCT FROM m.confidence)`,
      [userId]
    );
    return result.rowCount || 0;
  }

  /**
   * An on-chain flow to or from an exchange with no record behind it.
   *
   * Gated on the user having at least one deposit or withdrawal record
   * SOMEWHERE, and that gate is the whole design. Without it, labelling one
   * address "Coinbase" would flag every transfer to it for a user who tracks
   * wallets and nothing else -- a queue they cannot drain by doing the thing it
   * asks for, because they have no exchange to import. CLAUDE.md's triage rule
   * already learned what a badge that cannot reach zero costs: it gets ignored,
   * and takes the real flags with it.
   *
   * Once ANY export or key is in play, the gate opens and an unmatched exchange
   * flow is a real gap with three real answers: import the other venue, connect
   * its key, or override the transaction. Deliberately NOT bounded to the
   * period those records cover -- that bound looked tighter and quietly broke
   * the case this exists for, since deleting the account that explained a
   * transfer also shrinks the covered period past it, leaving the transfer
   * marked explained by evidence that no longer exists.
   */
  static async flagUnmatchedExchangeFlows(userId, reviewReason) {
    requireUserId('flagUnmatchedExchangeFlows', userId);
    const result = await pool.query(
      `UPDATE eth_activity a
       SET needs_review = TRUE, review_reason = $2, confidence = 'low'
       FROM eth_wallets w
       WHERE w.id = a.wallet_id AND w.user_id = $1
         -- The RESOLVED category, exactly as the candidate query reads it. A
         -- transaction the user corrected AWAY from an exchange flow stops
         -- generating candidates, so flagging it on the derived category would
         -- queue a review nothing can ever satisfy -- and one corrected INTO
         -- an exchange flow has to be able to enter the queue. A correlated
         -- subquery rather than a join: the UPDATE target cannot be referenced
         -- from an outer join in the FROM list.
         AND COALESCE(
               (SELECT o.category FROM eth_activity_overrides o
                WHERE o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash),
               a.category
             ) IN ('exchange_deposit', 'exchange_withdrawal')
         AND NOT a.needs_review
         AND NOT EXISTS (SELECT 1 FROM exchange_matches m WHERE m.activity_id = a.id)
         AND EXISTS (
           SELECT 1 FROM exchange_records er
           JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
           WHERE ea.user_id = $1 AND er.record_type = ANY($3::varchar[])
         )`,
      [userId, reviewReason, MATCHABLE_RECORD_TYPES]
    );
    return result.rowCount || 0;
  }

  /**
   * The venue's own address, learned from a match that PROVED it.
   *
   * Only ever called for hash matches (and for a user's own confirmation),
   * because only those are identity: the counterparty of a transaction the
   * exchange itself published is the exchange, full stop. A fallback match is
   * a guess, and a wrong 'exchange' label deletes real spending from cash flow.
   *
   * Writes ONLY when the address has no verdict of any kind, user or global.
   * That is how precedence stays intact without this needing to know the
   * precedence rules: a user's explicit label is never overwritten because it
   * is never written over, and a builtin's is never outranked because its mere
   * presence stops the insert.
   */
  static async learnExchangeLabel(userId, address, name) {
    requireUserId('learnExchangeLabel', userId);
    const result = await pool.query(
      `INSERT INTO eth_address_labels (user_id, address, name, source, confidence, kind, note)
       SELECT $1, $2::text, $3, 'auto-match', 'low', 'exchange',
              'Learned from a transaction this exchange published'
       WHERE NOT EXISTS (
         SELECT 1 FROM eth_address_labels
         WHERE address = $2::text AND (user_id = $1 OR user_id IS NULL)
       )
       ON CONFLICT (user_id, address) WHERE user_id IS NOT NULL DO NOTHING
       RETURNING address`,
      [userId, String(address).toLowerCase(), name]
    );
    return result.rows.length > 0;
  }

  // The matches feed. Newest movement first; the exchange record's own
  // timestamp leads because it is the one both shapes have.
  static async findForUser(userId, { limit = 100, offset = 0 } = {}) {
    requireUserId('findForUser', userId);
    const result = await pool.query(
      `SELECT ${MATCH_COLUMNS}, COUNT(*) OVER() AS total_count
       ${MATCH_FROM}
       WHERE ea.user_id = $1
       ORDER BY er.occurred_at DESC, m.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return {
      matches: result.rows.map((row) => {
        const rest = { ...row };
        delete rest.total_count;
        return rest;
      }),
      total,
    };
  }

  /**
   * How much of the picture is joined up. `unmatched_records` is the issue's
   * "record-side deposit from an unknown source" -- reported as a count rather
   * than written onto exchange_records.needs_review, because resolving THAT
   * flag is a one-way door (it is the ON CONFLICT upgrade gate, 037) and a
   * derived pass must not be able to close it.
   */
  static async summaryForUser(userId) {
    requireUserId('summaryForUser', userId);
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM exchange_matches m
          JOIN exchange_records er ON er.id = m.exchange_record_id
          JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
          WHERE ea.user_id = $1) AS matched,
         (SELECT COUNT(*)::int FROM exchange_records er
          JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
          WHERE ea.user_id = $1 AND er.record_type = ANY($2::varchar[])
            AND NOT EXISTS (SELECT 1 FROM exchange_matches m
                            WHERE m.exchange_record_id = er.id OR m.counter_record_id = er.id))
           AS unmatched_records,
         (SELECT COUNT(*)::int FROM eth_activity a
          JOIN eth_wallets w ON w.id = a.wallet_id
          LEFT JOIN eth_activity_overrides o
            ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
          WHERE w.user_id = $1
            -- Resolved category again: the count has to agree with what the
            -- matcher considers and what the flag pass queues.
            AND COALESCE(o.category, a.category) IN ('exchange_deposit', 'exchange_withdrawal')
            AND NOT EXISTS (SELECT 1 FROM exchange_matches m WHERE m.activity_id = a.id))
           AS unmatched_activities`,
      [userId, MATCHABLE_RECORD_TYPES]
    );
    const row = result.rows[0] || {};
    return {
      matched: Number(row.matched) || 0,
      unmatchedRecords: Number(row.unmatched_records) || 0,
      unmatchedActivities: Number(row.unmatched_activities) || 0,
    };
  }

  /**
   * Does this user own both sides of the pair they are answering about, and are
   * those sides the right SHAPE? A verdict against something they cannot see
   * would be stored and then invisible forever, the same trap
   * eth_activity_overrides has a 404 for.
   *
   * Returns the record rows as well as the verdict, because the route also has
   * to check what they are: only a deposit or a withdrawal can be half of a
   * movement, and a pair runs withdrawal -> deposit.
   */
  static async verdictTargetExists(userId, { exchangeRecordId, counterRecordId = null, walletId = null, chainId = DEFAULT_CHAIN_ID, txHash = null }) {
    requireUserId('verdictTargetExists', userId);
    const ownsRecord = await pool.query(
      `SELECT er.id, er.record_type
       FROM exchange_records er
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       WHERE ea.user_id = $1 AND er.id = ANY($2::bigint[])`,
      [userId, counterRecordId ? [exchangeRecordId, counterRecordId] : [exchangeRecordId]]
    );
    const expected = counterRecordId ? 2 : 1;
    const records = new Map(ownsRecord.rows.map((row) => [Number(row.id), row]));
    if (records.size !== expected) return { exists: false, records };
    if (counterRecordId) return { exists: true, records };

    const activity = await pool.query(
      `SELECT 1 FROM eth_activity a
       JOIN eth_wallets w ON w.id = a.wallet_id
       WHERE a.wallet_id = $1 AND a.chain_id = $2 AND a.tx_hash = $3 AND w.user_id = $4
       LIMIT 1`,
      [walletId, chainId, txHash, userId]
    );
    return { exists: activity.rows.length > 0, records };
  }

  /**
   * A CONFIRMED verdict that would claim a record this user has already
   * confirmed somewhere else.
   *
   * The unique indexes cannot see this: the two verdicts have different keys
   * (one on-chain, one a pair, or two pairs sharing a record), so both store
   * happily and selectMatches then discards whichever it reaches second --
   * silently, and by an ordering the user never sees. The same money cannot be
   * explained twice, so the second answer is refused at the door instead.
   */
  static async findConflictingConfirmation(userId, { exchangeRecordId, counterRecordId = null, walletId = null, chainId = null, txHash = null }) {
    requireUserId('findConflictingConfirmation', userId);
    const recordIds = counterRecordId ? [exchangeRecordId, counterRecordId] : [exchangeRecordId];
    const result = await pool.query(
      `SELECT v.id, v.exchange_record_id, v.counter_record_id, v.wallet_id, v.chain_id, v.tx_hash
       FROM exchange_match_verdicts v
       JOIN exchange_records er ON er.id = v.exchange_record_id
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       WHERE ea.user_id = $1
         AND v.verdict = 'confirmed'
         AND (v.exchange_record_id = ANY($2::bigint[]) OR v.counter_record_id = ANY($2::bigint[]))
         AND NOT (v.exchange_record_id = $3
                  AND v.counter_record_id IS NOT DISTINCT FROM $4
                  AND v.wallet_id IS NOT DISTINCT FROM $5
                  AND v.chain_id IS NOT DISTINCT FROM $6
                  AND v.tx_hash IS NOT DISTINCT FROM $7)
       ORDER BY v.id
       LIMIT 1`,
      [
        userId,
        recordIds,
        exchangeRecordId,
        counterRecordId,
        counterRecordId ? null : walletId,
        counterRecordId ? null : chainId,
        counterRecordId ? null : txHash,
      ]
    );
    return result.rows[0] || null;
  }

  // The account join AND the wallet EXISTS are the second ownership gate; the
  // route checks first. Both are needed: the record's account proves nothing
  // about the wallet id bound alongside it, and an unchecked wallet_id would
  // write a verdict pointing at another user's wallet. A verdict is an UPSERT
  // so re-answering replaces the previous answer instead of stacking a second
  // one.
  static async upsertVerdict(userId, { exchangeRecordId, counterRecordId = null, walletId = null, chainId = DEFAULT_CHAIN_ID, txHash = null, verdict, note = null }) {
    requireUserId('upsertVerdict', userId);
    const onChain = counterRecordId === null;
    const conflictTarget = onChain
      ? '(exchange_record_id, wallet_id, chain_id, tx_hash) WHERE counter_record_id IS NULL'
      : '(exchange_record_id, counter_record_id) WHERE counter_record_id IS NOT NULL';
    const result = await pool.query(
      `INSERT INTO exchange_match_verdicts
         (exchange_record_id, wallet_id, chain_id, tx_hash, counter_record_id, verdict, note)
       -- $2 is cast on both of its uses, or Postgres deduces two types for one
       -- parameter and refuses the statement outright.
       SELECT er.id, $2::int, $3, $4, $5, $6, $7
       FROM exchange_records er
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       WHERE er.id = $1 AND ea.user_id = $8
         AND ($2::int IS NULL OR EXISTS (
           SELECT 1 FROM eth_wallets w WHERE w.id = $2::int AND w.user_id = $8
         ))
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET verdict = EXCLUDED.verdict,
                     note = EXCLUDED.note,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        exchangeRecordId,
        onChain ? walletId : null,
        onChain ? chainId : null,
        onChain ? txHash : null,
        counterRecordId,
        verdict,
        note,
        userId,
      ]
    );
    return result.rows[0] || null;
  }

  // An answer the user regrets has to be undoable, exactly like an activity
  // override: deleting it uncovers whatever the matcher derives on its own.
  static async deleteVerdict(userId, { exchangeRecordId, counterRecordId = null, walletId = null, chainId = DEFAULT_CHAIN_ID, txHash = null }) {
    requireUserId('deleteVerdict', userId);
    const result = await pool.query(
      `DELETE FROM exchange_match_verdicts v
       USING exchange_records er
       JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
       WHERE v.exchange_record_id = er.id
         AND ea.user_id = $1
         AND v.exchange_record_id = $2
         AND v.counter_record_id IS NOT DISTINCT FROM $3
         AND v.wallet_id IS NOT DISTINCT FROM $4
         AND v.chain_id IS NOT DISTINCT FROM $5
         AND v.tx_hash IS NOT DISTINCT FROM $6
       RETURNING v.*`,
      [
        userId,
        exchangeRecordId,
        counterRecordId,
        counterRecordId === null ? walletId : null,
        counterRecordId === null ? chainId : null,
        counterRecordId === null ? txHash : null,
      ]
    );
    return result.rows[0] || null;
  }
}

module.exports = ExchangeMatch;
module.exports.DEFAULT_CHAIN_ID = DEFAULT_CHAIN_ID;
