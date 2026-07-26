'use strict';

const pool = require('../config/database');
const EthActivityService = require('../services/EthActivityService');

// The unified crypto ledger (#63): one chronological stream over the two places
// crypto activity is recorded -- eth_activity (on-chain, per transaction per
// owning wallet) and exchange_records (on-venue, per economic event).
//
// Ordered by TIME and nothing else. block_number is a per-chain sequence (039)
// and an exchange record has no block at all, so time is the only key the two
// sources share. The tiebreak is (source, row_id), which is unique across the
// union -- a non-total ORDER BY lets LIMIT/OFFSET repeat one row on page 2 and
// drop another entirely.
//
// Scope is inherited exactly as everywhere else: eth_activity through
// eth_wallets.user_id, exchange_records through exchange_accounts.user_id. Both
// joins are in the CTEs, so a missing userId cannot widen the feed -- and the
// entry points throw without one rather than serving an unscoped read.

// An exchange record and an on-chain activity row that carry the SAME
// transaction hash are one event seen from both sides: the venue's own ledger
// line for a withdrawal, and the wallet's receipt of it. Rendering both is
// double-counting the event and doubling the review burden, so the record is
// folded INTO the activity row and suppressed from its own branch.
//
// Keyed on the hash and nothing else. That is a fact both sides recorded, not a
// heuristic on amount and timestamp -- the fuzzy matcher (#61) is what will
// pair the legs that carry no hash, and it lands beside this rather than
// replacing it.
//
// DISTINCT ON (er.id) is load-bearing: exchange_records has no chain column
// (the on-chain side is chain-keyed since 039), and one hash can also belong to
// two activity rows when two of the user's own wallets are both party to the
// transaction. Picking the lowest activity id makes the fold deterministic and
// guarantees the record appears exactly ONCE -- against every activity row, it
// would appear as many times as the hash matched.
const MATCHED_CTE = `
  matched AS (
    SELECT DISTINCT ON (er.id) er.id AS record_id, a.id AS activity_id
    FROM exchange_records er
    JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
    JOIN eth_activity a ON LOWER(a.tx_hash) = LOWER(er.tx_hash)
    JOIN eth_wallets w ON w.id = a.wallet_id
    WHERE ea.user_id = $1
      AND w.user_id = $1
      AND er.tx_hash IS NOT NULL
      AND er.tx_hash <> ''
    ORDER BY er.id, a.id
  )`;

// The on-chain branch. Overrides are COALESCEd over the derived verdict in this
// one place, the same contract EthActivity.findForUser has: an override IS a
// review, so it also clears needs_review and its reason.
//
// needs_review ORs in the folded records' own flags. A flagged exchange record
// folded into an explained activity row would otherwise vanish from the review
// queue while still being unexplained -- the exact failure "no transaction
// unexplained" exists to prevent.
// record_type is the exchange's own vocabulary; it is mapped onto the activity
// layer's categories so ONE ?category= filter answers for both sources. The
// mapping is deliberately conservative:
//
//   trade / conversion -> exchange_trade   both are a venue-side trade
//   deposit            -> exchange_deposit the two halves of a deposit agree:
//   withdrawal         -> exchange_withdrawal   on-chain the same words mean
//                                               "into"/"out of the venue"
//   reward             -> staking_reward
//   fee                -> fee              ledger-only; no on-chain analogue
//   transfer           -> exchange_transfer a movement the venue did not
//                                           classify (Kraken's spot<->earn
//                                           moves, and the fail-closed landing
//                                           spot for an unrecognized row).
//
// 'transfer' is NOT mapped to self_transfer: that would assert both ends are
// the user's, which is precisely what the import could not determine.
//
// Taken as a function of the alias because it is needed twice -- once to give
// an unfolded record its category, and once so a FOLDED record can still be
// found by the category filter through its host row.
const recordCategory = (alias) => `
      CASE ${alias}.record_type
        WHEN 'trade' THEN 'exchange_trade'
        WHEN 'conversion' THEN 'exchange_trade'
        WHEN 'deposit' THEN 'exchange_deposit'
        WHEN 'withdrawal' THEN 'exchange_withdrawal'
        WHEN 'reward' THEN 'staking_reward'
        WHEN 'fee' THEN 'fee'
        ELSE 'exchange_transfer'
      END`;

const ONCHAIN_CTE = `
  onchain AS (
    SELECT
      'onchain'::text AS source,
      a.id AS row_id,
      a.block_time AS occurred_at,
      COALESCE(o.category, a.category)::text AS category,
      ((CASE WHEN o.category IS NOT NULL THEN FALSE ELSE a.needs_review END)
        OR COALESCE(m.any_review, FALSE)) AS needs_review,
      (CASE WHEN o.category IS NOT NULL THEN NULL ELSE a.review_reason END)::text AS review_reason,
      a.wallet_id,
      a.chain_id,
      a.tx_hash::text AS tx_hash,
      a.block_number,
      a.counterparty_address::text AS counterparty_address,
      a.counterparty_name::text AS counterparty_name,
      a.method_id::text AS method_id,
      a.method_name::text AS method_name,
      a.legs,
      a.fee_wei,
      a.confidence::text AS confidence,
      a.category::text AS derived_category,
      o.category::text AS override_category,
      o.note::text AS override_note,
      (o.category IS NOT NULL) AS is_overridden,
      w.address::text AS wallet_address,
      w.label::text AS wallet_label,
      NULL::int AS exchange_account_id,
      NULL::text AS exchange,
      NULL::text AS account_name,
      NULL::text AS record_type,
      NULL::text AS base_asset,
      NULL::numeric AS base_amount,
      NULL::text AS quote_asset,
      NULL::numeric AS quote_amount,
      NULL::text AS fee_asset,
      NULL::numeric AS fee_amount,
      NULL::text AS external_id,
      NULL::text AS record_address,
      NULL::text AS record_source,
      COALESCE(m.records, '[]'::jsonb) AS exchange_matches,
      -- What the folded halves would have been filed under on their own. The
      -- source/category/account filters read these too: a record suppressed
      -- from its own branch and then filtered out of its host would appear
      -- NOWHERE, which is a filter that silently DROPS an event rather than
      -- narrowing to it -- and the venue calls a deposit a "withdrawal", so
      -- that mismatch is the normal case, not the corner one.
      COALESCE(m.match_categories, ARRAY[]::text[]) AS match_categories,
      COALESCE(m.match_account_ids, ARRAY[]::int[]) AS match_account_ids
    FROM eth_activity a
    JOIN eth_wallets w ON w.id = a.wallet_id
    LEFT JOIN eth_activity_overrides o
      ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(jsonb_build_object(
          'id', er.id,
          'exchange_account_id', er.exchange_account_id,
          'account_name', ea.name,
          'exchange', ea.exchange,
          'record_type', er.record_type,
          'occurred_at', er.occurred_at,
          -- ::text on every NUMERIC(38,18). jsonb_build_object would emit them
          -- as JSON NUMBERS, and node-pg parses jsonb with JSON.parse -- so a
          -- folded amount would arrive as a double, print in exponent notation
          -- below 1e-6 and drop digits above 2^53. Nowhere else in this file
          -- does a quantity leave Postgres as anything but a string.
          'base_asset', er.base_asset, 'base_amount', er.base_amount::text,
          'quote_asset', er.quote_asset, 'quote_amount', er.quote_amount::text,
          'fee_asset', er.fee_asset, 'fee_amount', er.fee_amount::text,
          'external_id', er.external_id,
          'needs_review', er.needs_review,
          'source', er.source
        ) ORDER BY er.id) AS records,
        bool_or(er.needs_review) AS any_review,
        array_agg(DISTINCT ${recordCategory('er')}) AS match_categories,
        array_agg(DISTINCT er.exchange_account_id) AS match_account_ids
      FROM matched mm
      JOIN exchange_records er ON er.id = mm.record_id
      JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
      WHERE mm.activity_id = a.id
    ) m ON TRUE
    WHERE w.user_id = $1
  )`;

// The venue branch: every record the fold did not absorb.
const EXCHANGE_CTE = `
  exch AS (
    SELECT
      'exchange'::text AS source,
      er.id AS row_id,
      er.occurred_at,
      ${recordCategory('er')}::text AS category,
      er.needs_review,
      NULL::text AS review_reason,
      NULL::int AS wallet_id,
      NULL::int AS chain_id,
      er.tx_hash::text AS tx_hash,
      NULL::bigint AS block_number,
      NULL::text AS counterparty_address,
      NULL::text AS counterparty_name,
      NULL::text AS method_id,
      NULL::text AS method_name,
      '[]'::jsonb AS legs,
      NULL::numeric AS fee_wei,
      NULL::text AS confidence,
      NULL::text AS derived_category,
      NULL::text AS override_category,
      NULL::text AS override_note,
      FALSE AS is_overridden,
      NULL::text AS wallet_address,
      NULL::text AS wallet_label,
      er.exchange_account_id,
      ea.exchange::text AS exchange,
      ea.name::text AS account_name,
      er.record_type::text AS record_type,
      er.base_asset::text AS base_asset,
      er.base_amount,
      er.quote_asset::text AS quote_asset,
      er.quote_amount,
      er.fee_asset::text AS fee_asset,
      er.fee_amount,
      er.external_id::text AS external_id,
      er.address::text AS record_address,
      er.source::text AS record_source,
      '[]'::jsonb AS exchange_matches,
      ARRAY[]::text[] AS match_categories,
      ARRAY[]::int[] AS match_account_ids
    FROM exchange_records er
    JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
    WHERE ea.user_id = $1
      AND NOT EXISTS (SELECT 1 FROM matched mm WHERE mm.record_id = er.id)
  )`;

const LEDGER_CTE = `WITH ${MATCHED_CTE},\n${ONCHAIN_CTE},\n${EXCHANGE_CTE}`;

const UNION_SOURCE = '(SELECT * FROM onchain UNION ALL SELECT * FROM exch) r';

// The filter vocabulary the API validates against. The activity layer's own
// categories plus the two an exchange row can land on that no on-chain
// transaction ever produces. Single-sourced so the route, the CSV export and
// the client's filter list cannot drift from what the query can actually
// return -- an unknown ?category= is a 400, so a client offering a value the
// server does not know is a broken filter, not a wider feed.
const EXCHANGE_ONLY_CATEGORIES = ['fee', 'exchange_transfer'];
const LEDGER_CATEGORIES = [...EthActivityService.CATEGORIES, ...EXCHANGE_ONLY_CATEGORIES];
const LEDGER_SOURCES = ['onchain', 'exchange'];

// Base units -> a whole-unit decimal string, exactly. fee_wei is NUMERIC(78,0)
// and arrives as a string; Number() would round a value that has more
// significant digits than a double can hold, which is most of them.
function weiToDecimalString(value, decimals = 18) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  let raw;
  try {
    raw = BigInt(text.split('.')[0]);
  } catch {
    return null;
  }
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${frac ? `${whole}.${frac}` : whole}`;
}

// NUMERIC(38,18) arrives as '-0.500000000000000000'. Strips the padding without
// going through a float, so an 18-decimal quantity survives intact.
function trimDecimal(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

function isZero(value) {
  return value === null || value === undefined || Number.parseFloat(value) === 0;
}

function absDecimal(value) {
  const text = trimDecimal(value);
  return text && text.startsWith('-') ? text.slice(1) : text;
}

// One leg shape for both sources, so every reader -- the table, the CSV export,
// a future chart -- describes an event the same way. On-chain rows already
// carry netted legs from the activity builder; an exchange record's base and
// quote columns are turned into the same thing here rather than in the query,
// because it is presentation, not filtering.
//
// The exchange amounts are stored SIGNED as the venue wrote them (a sell's base
// is negative), which is exactly the direction information a leg needs.
function exchangeLegs(row) {
  const legs = [];
  if (row.base_asset && !isZero(row.base_amount)) {
    legs.push({
      asset: row.base_asset,
      direction: String(row.base_amount).trim().startsWith('-') ? 'out' : 'in',
      amount: absDecimal(row.base_amount),
    });
  }
  if (row.quote_asset && !isZero(row.quote_amount)) {
    legs.push({
      asset: row.quote_asset,
      direction: String(row.quote_amount).trim().startsWith('-') ? 'out' : 'in',
      amount: absDecimal(row.quote_amount),
    });
  }
  return legs;
}

// One JSON row shape for both sources. Every source-specific column stays on
// the row (an on-chain row keeps its tx hash and method name, a venue row keeps
// its external id) -- the point is that the fields a LEDGER needs are in the
// same place on both.
function toLedgerRow(row) {
  const onChain = row.source === 'onchain';
  const legs = onChain ? (row.legs || []) : exchangeLegs(row);
  return {
    // Composite, because neither id is unique across the union.
    //
    // On-chain rows key on (chain, hash, wallet) rather than eth_activity.id:
    // the table is DELETEd and rebuilt wholesale on every sync and every label
    // write, so every row gets a fresh BIGSERIAL. An id-keyed client would see
    // its open row vanish the moment a label reclassified the history -- while
    // the transaction it was looking at is still right there. The triple is
    // exactly the table's UNIQUE key, so it is stable and unique.
    // exchange_records are never rebuilt, so their id is already stable.
    id: onChain
      ? `onchain:${row.chain_id}:${row.tx_hash}:${row.wallet_id}`
      : `exchange:${row.row_id}`,
    source: row.source,
    row_id: Number(row.row_id),
    occurred_at: row.occurred_at,
    category: row.category,
    needs_review: row.needs_review === true,
    review_reason: row.review_reason,
    legs,
    // Fee, in the same shape on both sides: a whole-unit amount and its asset.
    // On-chain that is gas, always ETH; on a venue it is whatever the venue
    // charged in.
    fee_amount: onChain ? weiToDecimalString(row.fee_wei) : trimDecimal(row.fee_amount),
    fee_asset: onChain ? 'ETH' : row.fee_asset,
    // On-chain only
    wallet_id: row.wallet_id,
    wallet_address: row.wallet_address,
    wallet_label: row.wallet_label,
    chain_id: row.chain_id,
    tx_hash: row.tx_hash,
    block_number: row.block_number != null ? String(row.block_number) : null,
    counterparty_address: row.counterparty_address,
    counterparty_name: row.counterparty_name,
    method_id: row.method_id,
    method_name: row.method_name,
    fee_wei: row.fee_wei,
    confidence: row.confidence,
    derived_category: row.derived_category,
    override_category: row.override_category,
    override_note: row.override_note,
    is_overridden: row.is_overridden === true,
    // Exchange only
    exchange_account_id: row.exchange_account_id,
    exchange: row.exchange,
    account_name: row.account_name,
    record_type: row.record_type,
    base_asset: row.base_asset,
    base_amount: trimDecimal(row.base_amount),
    quote_asset: row.quote_asset,
    quote_amount: trimDecimal(row.quote_amount),
    external_id: row.external_id,
    record_address: row.record_address,
    record_source: row.record_source,
    // The venue-side halves folded into this row, if any.
    exchange_matches: row.exchange_matches || [],
  };
}

// Builds the WHERE for the union. `params` is mutated: it already holds $1
// (userId) and grows one entry per active filter.
// A FOLDED row answers to BOTH of its identities. The record was suppressed
// from its own branch, so if the filter only tested the host's own columns the
// event would appear nowhere at all -- a filter that drops an event rather than
// narrowing to it, which is the exact failure "no transaction unexplained"
// exists to prevent. It is also the normal case, not a corner one: the venue
// files a "withdrawal" for the transaction the wallet files as a deposit.
function buildFilters({ category, needsReview, source, walletId, exchangeAccountId }, params) {
  const clauses = [];
  if (source) {
    params.push(source);
    clauses.push(`(r.source = $${params.length}
      OR ($${params.length} = 'exchange' AND jsonb_array_length(r.exchange_matches) > 0))`);
  }
  if (category) {
    params.push(category);
    clauses.push(`(r.category = $${params.length} OR $${params.length} = ANY(r.match_categories))`);
  }
  if (needsReview !== null && needsReview !== undefined) {
    // Already ORed across the pair inside the onchain branch, so this needs no
    // second arm: a flagged half raises its host's flag.
    params.push(needsReview);
    clauses.push(`r.needs_review = $${params.length}`);
  }
  // A wallet narrows to that wallet's transactions, folded halves included --
  // they belong to the transaction, so they belong to its wallet.
  if (walletId != null) {
    params.push(walletId);
    clauses.push(`r.wallet_id = $${params.length}`);
  }
  if (exchangeAccountId != null) {
    params.push(exchangeAccountId);
    clauses.push(`(r.exchange_account_id = $${params.length} OR $${params.length} = ANY(r.match_account_ids))`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

class CryptoLedger {
  static get CATEGORIES() {
    return LEDGER_CATEGORIES;
  }

  static get SOURCES() {
    return LEDGER_SOURCES;
  }

  static async findForUser(userId, filters = {}) {
    if (!userId) throw new Error('CryptoLedger.findForUser requires a userId');
    const { limit = 100, offset = 0 } = filters;
    const params = [userId];
    const where = buildFilters(filters, params);
    params.push(limit, offset);

    const result = await pool.query(
      `${LEDGER_CTE}
       SELECT r.*, COUNT(*) OVER() AS total_count
       FROM ${UNION_SOURCE}
       ${where}
       -- Time is the only order the two sources share. (source, row_id) is
       -- unique across the union, so the ordering is total and paging stable.
       ORDER BY r.occurred_at DESC, r.source DESC, r.row_id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    return { rows: result.rows.map(toLedgerRow), total };
  }

  // The whole filtered ledger, for the CSV export. Capped rather than
  // unbounded: the export is built in memory, and a cap that says so beats an
  // out-of-memory failure on a wallet with a decade of history.
  static async findAllForUser(userId, filters = {}) {
    if (!userId) throw new Error('CryptoLedger.findAllForUser requires a userId');
    const { limit = 50000 } = filters;
    const params = [userId];
    const where = buildFilters(filters, params);
    params.push(limit);

    const result = await pool.query(
      `${LEDGER_CTE}
       SELECT r.*
       FROM ${UNION_SOURCE}
       ${where}
       ORDER BY r.occurred_at DESC, r.source DESC, r.row_id DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map(toLedgerRow);
  }

  // The badge. Counts the SAME rows the feed renders -- folded pairs once, with
  // the venue half's flag ORed in -- so "needs review" in the badge and in the
  // filter can never disagree.
  //
  // No materiality floor, unlike the counterparty triage badge. That one counts
  // a population it cannot drain (an unlabeled dust airdrop is unlabelable in
  // practice), so it needs a floor to reach zero. Every row here is resolvable
  // by hand in two clicks -- an override on the on-chain side, a resolve on the
  // venue side -- so the count already reaches zero, and a floor would only
  // hide rows the user is being asked to explain.
  static async summaryForUser(userId) {
    if (!userId) throw new Error('CryptoLedger.summaryForUser requires a userId');
    const result = await pool.query(
      `${LEDGER_CTE}
       SELECT
         COUNT(*)::int AS total,
         (COUNT(*) FILTER (WHERE r.needs_review))::int AS needs_review_count,
         (COUNT(*) FILTER (WHERE r.source = 'onchain'))::int AS onchain_count,
         -- Records, not rows: a folded record is still a record the venue
         -- wrote, and this number sits next to Settings' per-account
         -- record_count where the two disagreeing reads as a lost import.
         (COUNT(*) FILTER (WHERE r.source = 'exchange')
           + COALESCE(SUM(jsonb_array_length(r.exchange_matches)), 0))::int AS exchange_count,
         (COUNT(*) FILTER (WHERE r.needs_review AND r.source = 'onchain'))::int AS onchain_needs_review,
         (COUNT(*) FILTER (WHERE r.needs_review AND r.source = 'exchange'))::int AS exchange_needs_review,
         COALESCE(SUM(jsonb_array_length(r.exchange_matches)), 0)::int AS matched_count,
         MIN(r.occurred_at) AS first_at,
         MAX(r.occurred_at) AS last_at
       FROM ${UNION_SOURCE}`,
      [userId]
    );
    const row = result.rows[0] || {};
    return {
      total: Number(row.total) || 0,
      needs_review_count: Number(row.needs_review_count) || 0,
      onchain_count: Number(row.onchain_count) || 0,
      exchange_count: Number(row.exchange_count) || 0,
      onchain_needs_review: Number(row.onchain_needs_review) || 0,
      exchange_needs_review: Number(row.exchange_needs_review) || 0,
      matched_count: Number(row.matched_count) || 0,
      first_at: row.first_at || null,
      last_at: row.last_at || null,
    };
  }
}

module.exports = CryptoLedger;
module.exports.LEDGER_CATEGORIES = LEDGER_CATEGORIES;
module.exports.EXCHANGE_ONLY_CATEGORIES = EXCHANGE_ONLY_CATEGORIES;
module.exports.weiToDecimalString = weiToDecimalString;
module.exports.trimDecimal = trimDecimal;
