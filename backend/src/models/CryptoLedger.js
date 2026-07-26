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
//
// The FOLD joins carry the predicate too, and that is not redundant. A row
// reached through `exchange_matches` is reached by ID: nothing in the schema
// forbids a match row whose two sides belong to different users, and an
// unscoped fold join would render user 2's record inside user 1's feed. The
// matcher never writes one today; the ledger does not depend on that staying
// true. Every one of `mer`/`mea`, `cer`/`cea`, the matched_records CTE and both
// rejected-verdict LATERALs tests $1 on the record's own account.

// Which exchange records are already accounted for on another row.
//
// This is #61's matcher, NOT a hash comparison done here: `exchange_matches`
// already decided that "sent 1.4 ETH to Coinbase" and "Coinbase received
// 1.4 ETH" are one movement, with evidence (tx_hash / address_amount /
// amount_window / manual), a confidence, and a user verdict that can overrule
// it. Re-deriving that in this file would be a second matcher disagreeing with
// the first.
//
// Two shapes, per 041's one_shape CHECK:
//   activity_id + record        -> the record folds into the on-chain row
//   record + counter_record_id  -> a venue-to-venue transfer that never touched
//                                  a tracked wallet; the counter folds into the
//                                  primary, which is the orientation the table
//                                  itself carries
// Either way the movement renders ONCE. Both unique indexes guarantee at most
// one match per record, so no fold can fan a row into two.
const MATCHED_CTE = `
  matched_records AS (
    SELECT em.exchange_record_id AS record_id
    FROM exchange_matches em
    JOIN eth_activity a ON a.id = em.activity_id
    JOIN eth_wallets w ON w.id = a.wallet_id
    -- The record side is scoped too. Suppressing a record because SOMEBODY's
    -- transaction folded it would delete another user's row from their own
    -- feed; the wallet's owner is not evidence about the record's owner.
    JOIN exchange_records mr ON mr.id = em.exchange_record_id
    JOIN exchange_accounts mra ON mra.id = mr.exchange_account_id
    WHERE w.user_id = $1 AND mra.user_id = $1
    UNION
    SELECT em.counter_record_id AS record_id
    FROM exchange_matches em
    JOIN exchange_records er ON er.id = em.exchange_record_id
    JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
    WHERE ea.user_id = $1 AND em.counter_record_id IS NOT NULL
  )`;

// record_type is the exchange's own vocabulary; it is mapped onto the activity
// layer's categories here so ONE ?category= filter answers for both sources.
// The mapping is deliberately conservative:
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
// Taken as a function of the alias because it is needed three times -- an
// unfolded record's own category, and the category a FOLDED record would have
// had, so the category filter can still find it through its host row.
//
// The NULL guard is load-bearing on the folded arm: `mer` and `cer` are LEFT
// JOINs, and a bare CASE over a NULL record_type falls to the ELSE. That would
// stamp 'exchange_transfer' on EVERY unmatched row, and the category filter's
// second arm (`OR r.match_category = $n`) would then return the entire ledger
// for that one value -- a filter that silently widens, which is the failure
// every other filter here is fail-closed against.
const recordCategory = (alias) => `
      CASE WHEN ${alias}.id IS NULL THEN NULL ELSE
        CASE ${alias}.record_type
          WHEN 'trade' THEN 'exchange_trade'
          WHEN 'conversion' THEN 'exchange_trade'
          WHEN 'deposit' THEN 'exchange_deposit'
          WHEN 'withdrawal' THEN 'exchange_withdrawal'
          WHEN 'reward' THEN 'staking_reward'
          WHEN 'fee' THEN 'fee'
          ELSE 'exchange_transfer'
        END
      END`;

// The folded venue half, as JSON.
//
// ::text on every NUMERIC. jsonb_build_object would emit them as JSON NUMBERS,
// and node-pg parses jsonb with JSON.parse -- so a folded amount would arrive
// as a double, print in exponent notation below 1e-6 and drop digits above
// 2^53. Nowhere else in this file does a quantity leave Postgres as anything
// but a string.
// `verdict_*` are the ids a confirm/reject must be addressed to, stated by the
// side that knows: 041's verdict table keys an on-chain match on the matched
// record plus (wallet, chain, tx_hash), and a venue pair on BOTH record ids in
// the table's own orientation. Inferring that client-side from `record_id`
// alone gets the venue-pair case backwards, because the record shown is the
// COUNTER while the verdict is keyed on the primary.
const matchJson = (em, er, ea, mv) => `jsonb_build_object(
      'match_id', ${em}.id,
      'exchange_record_id', ${er}.id,
      'verdict_exchange_record_id', ${em}.exchange_record_id,
      'verdict_counter_record_id', ${em}.counter_record_id,
      'match_method', ${em}.match_method,
      'match_confidence', ${em}.confidence,
      'verdict', ${mv}.verdict,
      'exchange_account_id', ${ea}.id,
      'account_name', ${ea}.name,
      'exchange', ${ea}.exchange,
      'record_type', ${er}.record_type,
      'occurred_at', ${er}.occurred_at,
      'base_asset', ${er}.base_asset, 'base_amount', ${er}.base_amount::text,
      'quote_asset', ${er}.quote_asset, 'quote_amount', ${er}.quote_amount::text,
      'fee_asset', ${er}.fee_asset, 'fee_amount', ${er}.fee_amount::text,
      'external_id', ${er}.external_id,
      'needs_review', ${er}.needs_review,
      'category', ${recordCategory(er)}
    )`;

// The on-chain branch. Overrides are COALESCEd over the derived verdict in this
// one place, the same contract EthActivity.findForUser has: an override IS a
// review, so it also clears needs_review and its reason.
//
// needs_review ORs in the folded record's own flag. A flagged exchange record
// folded into an explained activity row would otherwise vanish from the review
// queue while still being unexplained -- the exact failure "no transaction
// unexplained" exists to prevent.
const ONCHAIN_RAW_CTE = `
  onchain_raw AS (
    SELECT
      'onchain'::text AS source,
      a.id AS row_id,
      a.block_time AS occurred_at,
      COALESCE(o.category, a.category)::text AS category,
      ((CASE WHEN o.category IS NOT NULL THEN FALSE ELSE a.needs_review END)
        OR COALESCE(mer.needs_review, FALSE)) AS needs_review,
      FALSE AS record_needs_review,
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
      -- At-the-time USD (043). Never recomputed here: the dollars are
      -- denormalized onto the row by the valuation pass, so every reader agrees
      -- on what a 2017 transfer was worth in 2017.
      a.usd_value::text AS usd_value,
      a.usd_fee::text AS usd_fee,
      a.usd_basis::text AS usd_basis,
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
      -- Guarded on mer, not on em: the record join carries the ownership
      -- predicate, so a match row pointing at somebody else's record leaves
      -- mer NULL and the fold simply does not happen.
      CASE WHEN mer.id IS NULL THEN NULL ELSE ${matchJson('em', 'mer', 'mea', 'mv')} END AS exchange_match,
      -- A REJECTED pairing leaves no exchange_matches row at all -- the
      -- selection pass drops the candidate -- so the pair splits back into two
      -- rows and the match object above is NULL. Without this the rejection is
      -- a one-way door: the verdict is stored, the matcher will never propose
      -- that pairing again, and nothing on screen can undo it. Joined on
      -- (wallet, chain, tx_hash) independently of the match itself.
      rv.verdict::text AS rejected_verdict,
      rv.exchange_record_id AS rejected_record_id,
      rv.counter_record_id AS rejected_counter_record_id,
      -- What the folded half would have been filed under on its own. The
      -- source/category/account filters read these too: a record suppressed
      -- from its own branch and then filtered out of its host would appear
      -- NOWHERE, which is a filter that silently DROPS an event rather than
      -- narrowing to it -- and the venue calls a deposit a "withdrawal", so
      -- that mismatch is the normal case, not the corner one.
      ${recordCategory('mer')}::text AS match_category,
      mea.id AS match_account_id,
      -- Which side of a wallet-to-wallet transfer this row is. Two of the
      -- user's own wallets both record the same transaction (038's UNIQUE is
      -- per WALLET), and the collapse below hosts the sending side.
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(a.legs, '[]'::jsonb)) l
        WHERE l->>'direction' = 'out'
      ) AS has_out_leg
    FROM eth_activity a
    JOIN eth_wallets w ON w.id = a.wallet_id
    LEFT JOIN eth_activity_overrides o
      ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
    -- At most one match per activity row (041's unique index says so), so none
    -- of these can fan one row into two.
    LEFT JOIN exchange_matches em ON em.activity_id = a.id
    LEFT JOIN exchange_records mer ON mer.id = em.exchange_record_id
      AND EXISTS (SELECT 1 FROM exchange_accounts oa
                  WHERE oa.id = mer.exchange_account_id AND oa.user_id = $1)
    LEFT JOIN exchange_accounts mea ON mea.id = mer.exchange_account_id AND mea.user_id = $1
    LEFT JOIN exchange_match_verdicts mv
      ON mv.exchange_record_id = em.exchange_record_id
     AND mv.counter_record_id IS NULL
     AND mv.wallet_id = a.wallet_id
     AND mv.chain_id = a.chain_id
     AND mv.tx_hash = a.tx_hash
    -- Independent of em: this is how a REJECTED pairing stays undoable, since
    -- rejecting deletes the match row. DISTINCT ON keeps it 1:1 -- a
    -- transaction the user rejected against two different records would
    -- otherwise fan its row.
    LEFT JOIN LATERAL (
      SELECT v.verdict, v.exchange_record_id, v.counter_record_id
      FROM exchange_match_verdicts v
      JOIN exchange_records vr ON vr.id = v.exchange_record_id
      JOIN exchange_accounts vea ON vea.id = vr.exchange_account_id
      WHERE v.wallet_id = a.wallet_id
        AND v.chain_id = a.chain_id
        AND v.tx_hash = a.tx_hash
        AND v.counter_record_id IS NULL
        AND v.verdict = 'rejected'
        AND vea.user_id = $1
      ORDER BY v.exchange_record_id
      LIMIT 1
    ) rv ON TRUE
    WHERE w.user_id = $1
  )`;

// One TRANSACTION, one ledger event.
//
// 038's UNIQUE is per (wallet, chain, tx_hash), so a transfer between two of
// the user's OWN tracked wallets is two eth_activity rows -- the sender's and
// the receiver's -- sharing (chain_id, tx_hash). Rendering both doubles the
// event: a $6,000 self-transfer summed to $12,000, the summary counted two
// events, and the CSV export inherited both. So the group collapses to ONE row
// here, in the same presentation shape as the exchange fold: a host row plus
// the other halves folded into `self_match`.
//
// The HOST is the out-leg row -- the wallet that sent, which is also the wallet
// that paid the gas -- so the surviving row's legs, fee and dollars describe
// the movement from the side that made it. `fee_wei DESC` then `wallet_id`
// break the tie, so the choice is deterministic across runs and paging is
// stable.
//
// Partitioned on (chain_id, tx_hash), never tx_hash alone -- exactly 038's own
// rule. A cross-chain replay (the same account, nonce and calldata on two
// chains) genuinely shares a hash and is two real, separate movements.
//
// needs_review is ORed across the group for the same reason the exchange fold
// ORs it: a flagged receiving row folded into an explained sending row would
// leave the review queue while still being unexplained.
const ONCHAIN_CTE = `
  onchain AS (
    SELECT
      r.source, r.row_id, r.occurred_at, r.category,
      (r.needs_review OR r.group_needs_review) AS needs_review,
      r.record_needs_review, r.review_reason,
      r.wallet_id, r.chain_id, r.tx_hash, r.block_number,
      r.counterparty_address, r.counterparty_name, r.method_id, r.method_name,
      r.legs, r.fee_wei, r.confidence,
      r.usd_value, r.usd_fee, r.usd_basis,
      r.derived_category, r.override_category, r.override_note, r.is_overridden,
      r.wallet_address, r.wallet_label,
      r.exchange_account_id, r.exchange, r.account_name, r.record_type,
      r.base_asset, r.base_amount, r.quote_asset, r.quote_amount,
      r.fee_asset, r.fee_amount, r.external_id, r.record_address, r.record_source,
      r.exchange_match,
      r.rejected_verdict, r.rejected_record_id, r.rejected_counter_record_id,
      r.match_category, r.match_account_id,
      fold.wallets AS self_match,
      -- The folded wallets stay addressable by the wallet filter. Without this
      -- a self-transfer would vanish when narrowed to the RECEIVING wallet --
      -- the filter dropping the event instead of narrowing to it, which is the
      -- same failure the exchange fold's second filter arm exists to prevent.
      fold.wallet_ids AS fold_wallet_ids
    FROM (
      SELECT q.*,
        ROW_NUMBER() OVER (
          PARTITION BY q.chain_id, q.tx_hash
          ORDER BY q.has_out_leg DESC, q.fee_wei DESC NULLS LAST, q.wallet_id
        ) AS rn,
        BOOL_OR(q.needs_review) OVER (PARTITION BY q.chain_id, q.tx_hash) AS group_needs_review
      FROM onchain_raw q
    ) r
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(jsonb_build_object(
          'wallet_id', f.wallet_id,
          'wallet_label', f.wallet_label,
          'wallet_address', f.wallet_address,
          'category', f.category,
          'needs_review', f.needs_review,
          'legs', f.legs
        ) ORDER BY f.wallet_id) AS wallets,
        array_agg(f.wallet_id ORDER BY f.wallet_id) AS wallet_ids
      FROM onchain_raw f
      WHERE f.chain_id = r.chain_id
        AND f.tx_hash = r.tx_hash
        AND f.row_id <> r.row_id
    ) fold ON TRUE
    WHERE r.rn = 1
  )`;

// What counts as "the venue quoted this in dollars". Stablecoins are included
// because a venue books a USDC pair as the dollar side of the trade; they are
// not pegged by law, but no better figure exists for a row 043 does not value.
const FIAT_ASSETS = "('USD', 'USDC', 'USDT', 'DAI', 'ZUSD')";

// One expression, used for both the value and the basis so the two cannot
// disagree about whether a dollar figure exists.
const FIAT_VALUE_SQL = `
      CASE WHEN UPPER(er.quote_asset) IN ${FIAT_ASSETS} AND er.quote_amount IS NOT NULL
             THEN ABS(er.quote_amount)::text
           WHEN UPPER(er.base_asset) IN ${FIAT_ASSETS} AND er.base_amount IS NOT NULL
             THEN ABS(er.base_amount)::text
      END`;

// The venue branch: every record no other row already accounts for.
//
// A record that is the PRIMARY of a venue-to-venue pair keeps its row and folds
// its counter in; a record that is somebody's counter, or that folded into an
// on-chain row, is suppressed here.
const EXCHANGE_CTE = `
  exch AS (
    SELECT
      'exchange'::text AS source,
      er.id AS row_id,
      er.occurred_at,
      ${recordCategory('er')}::text AS category,
      (er.needs_review OR COALESCE(cer.needs_review, FALSE)) AS needs_review,
      -- THIS record's own flag, beside the ORed one above. On a folded pair the
      -- row-level flag can belong to the other half, and a "Mark reviewed"
      -- button wired to the OR would resolve a record that is already clear and
      -- leave the row still flagged.
      er.needs_review AS record_needs_review,
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
      -- exchange_records carry no dated valuation: 043 values the on-chain
      -- ledger, and a venue row is only in dollars when the venue itself quoted
      -- it in dollars. That case is EXACT -- the venue wrote the number -- and
      -- every other case is honestly unpriced rather than silently zero.
      ${FIAT_VALUE_SQL} AS usd_value,
      CASE WHEN UPPER(er.fee_asset) IN ${FIAT_ASSETS}
             AND er.fee_amount IS NOT NULL
           THEN ABS(er.fee_amount)::text
      END AS usd_fee,
      -- Derived from whether the VALUE resolved, not from the asset alone: an
      -- import can write base_asset='USD' with a NULL base_amount (a cell it
      -- could not read, flagged for review), and a basis of 'exact' beside an
      -- empty dollar column is a blank in a summed column labelled as a real
      -- figure -- exactly the gap-versus-zero confusion the basis exists to
      -- resolve.
      CASE WHEN ${FIAT_VALUE_SQL} IS NOT NULL THEN 'exact' ELSE 'unpriced' END AS usd_basis,
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
      CASE WHEN cer.id IS NULL THEN NULL ELSE ${matchJson('cem', 'cer', 'cea', 'cmv')} END AS exchange_match,
      -- The venue side needs the rejected-verdict handle just as much as the
      -- on-chain side does, and for the same reason: rejecting a pairing
      -- DELETES the exchange_matches row, the selection pass drops the
      -- candidate, and the pair splits into two rows carrying no match object.
      -- Hardcoding NULL here made rejecting a venue-to-venue pair permanent --
      -- the Undo button never rendered and no other screen reaches the clear
      -- endpoint. Matched on EITHER side of the pair, because both halves come
      -- back as their own rows and either one should be able to undo it.
      crv.verdict::text AS rejected_verdict,
      crv.exchange_record_id AS rejected_record_id,
      crv.counter_record_id AS rejected_counter_record_id,
      ${recordCategory('cer')}::text AS match_category,
      cea.id AS match_account_id,
      NULL::jsonb AS self_match,
      NULL::int[] AS fold_wallet_ids
    FROM exchange_records er
    JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
    -- The venue-to-venue pair this record is the primary of, if any.
    LEFT JOIN exchange_matches cem
      ON cem.exchange_record_id = er.id AND cem.counter_record_id IS NOT NULL
    LEFT JOIN exchange_records cer ON cer.id = cem.counter_record_id
      AND EXISTS (SELECT 1 FROM exchange_accounts oa
                  WHERE oa.id = cer.exchange_account_id AND oa.user_id = $1)
    LEFT JOIN exchange_accounts cea ON cea.id = cer.exchange_account_id AND cea.user_id = $1
    LEFT JOIN exchange_match_verdicts cmv
      ON cmv.exchange_record_id = cem.exchange_record_id
     AND cmv.counter_record_id = cem.counter_record_id
    LEFT JOIN LATERAL (
      SELECT v.verdict, v.exchange_record_id, v.counter_record_id
      FROM exchange_match_verdicts v
      JOIN exchange_records vr ON vr.id = v.exchange_record_id
      JOIN exchange_accounts vea ON vea.id = vr.exchange_account_id
      WHERE (v.exchange_record_id = er.id OR v.counter_record_id = er.id)
        AND v.counter_record_id IS NOT NULL
        AND v.verdict = 'rejected'
        AND vea.user_id = $1
      ORDER BY v.exchange_record_id, v.counter_record_id
      LIMIT 1
    ) crv ON TRUE
    WHERE ea.user_id = $1
      AND NOT EXISTS (SELECT 1 FROM matched_records mm WHERE mm.record_id = er.id)
  )`;

const LEDGER_CTE = `WITH ${MATCHED_CTE},\n${ONCHAIN_RAW_CTE},\n${ONCHAIN_CTE},\n${EXCHANGE_CTE}`;

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

// A whole-unit decimal string -> the base-unit integer and the scale that
// produced it, so the client can render it with the SHARED formatTokenUnits
// (which is BigInt end to end) instead of a second formatter of its own.
// '0.5' -> {units: '5', decimals: 1}; '1832.412345' -> {'1832412345', 6}.
function toBaseUnits(value) {
  const text = trimDecimal(value);
  if (text === null) return { units: null, decimals: 0 };
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace(/^-/, '').split('.');
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, '') || '0';
  return { units: `${negative && digits !== '0' ? '-' : ''}${digits}`, decimals: frac.length };
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
function legsFromAmounts(pairs) {
  const legs = [];
  for (const [asset, amount] of pairs) {
    if (!asset || isZero(amount)) continue;
    const magnitude = absDecimal(amount);
    legs.push({
      asset,
      direction: String(amount).trim().startsWith('-') ? 'out' : 'in',
      amount: magnitude,
      ...toBaseUnits(magnitude),
    });
  }
  return legs;
}

function exchangeLegs(row) {
  return legsFromAmounts([[row.base_asset, row.base_amount], [row.quote_asset, row.quote_amount]]);
}

// The legs a folded venue half contributes. Rendered on the SAME row: the
// on-chain legs alone describe half the event -- the wallet's outflow without
// the venue's credit.
function matchLegs(match) {
  if (!match) return [];
  return legsFromAmounts([[match.base_asset, match.base_amount], [match.quote_asset, match.quote_amount]]);
}

// Every on-chain leg gets base units too, from the whole-unit `amount` the
// activity builder wrote. Not from `amount_raw`: that is in the ASSET's own
// base units and the legs JSONB carries no decimals column to interpret it
// with, so scaling it would need a token lookup per leg. `amount` is already
// full precision, and its own fraction length is the scale that renders it.
function withBaseUnits(legs) {
  return (legs || []).map((leg) => ({ ...leg, ...toBaseUnits(leg.amount) }));
}

// One JSON row shape for both sources. Every source-specific column stays on
// the row (an on-chain row keeps its tx hash and method name, a venue row keeps
// its external id) -- the point is that the fields a LEDGER needs are in the
// same place on both.
function toLedgerRow(row) {
  const onChain = row.source === 'onchain';
  const legs = onChain ? withBaseUnits(row.legs) : exchangeLegs(row);
  const feeAmount = onChain ? weiToDecimalString(row.fee_wei) : trimDecimal(row.fee_amount);
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
    record_needs_review: row.record_needs_review === true,
    review_reason: row.review_reason,
    legs,
    // Fee, in the same shape on both sides: a whole-unit amount and its asset.
    // On-chain that is gas, always ETH; on a venue it is whatever the venue
    // charged in.
    fee_amount: feeAmount,
    fee_asset: onChain ? 'ETH' : row.fee_asset,
    ...(() => {
      const { units, decimals } = toBaseUnits(feeAmount);
      return { fee_units: units, fee_decimals: decimals };
    })(),
    // At-the-time dollars (043 on-chain; the venue's own quote off-venue).
    // NULL is "no price for this asset on that date", never zero -- which is
    // why usd_basis rides along and GET /api/eth/prices/unpriced exists.
    //
    // Trimmed: a venue figure comes off NUMERIC(38,18), so an untrimmed
    // "1832.400000000000000000" would land in the CSV's money column and read
    // as a quantity rather than a price.
    usd_value: trimDecimal(row.usd_value),
    usd_fee: trimDecimal(row.usd_fee),
    usd_basis: row.usd_basis,
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
    // The other half of this movement (#61), folded in, with its own legs
    // already shaped so a reader never has to know which side it came from.
    exchange_match: row.exchange_match
      ? { ...row.exchange_match, legs: matchLegs(row.exchange_match) }
      : null,
    // A pairing this row was rejected against. There is no match row to hang it
    // on (rejecting deletes it), so it rides separately -- it is what makes
    // "Not the same" undoable rather than permanent. `counter_record_id` says
    // which of 041's two shapes it was, because clearing the verdict has to be
    // addressed in the same shape it was stored in.
    rejected_match: row.rejected_verdict
      ? {
        exchange_record_id: Number(row.rejected_record_id),
        counter_record_id: row.rejected_counter_record_id != null
          ? Number(row.rejected_counter_record_id)
          : null,
      }
      : null,
    // The other wallet(s) of this same transaction, folded in. 038 writes one
    // eth_activity row per WALLET, so a transfer between two tracked wallets is
    // two rows for one movement; the sending side hosts and the rest ride here.
    self_match: Array.isArray(row.self_match)
      ? row.self_match.map((half) => ({ ...half, legs: withBaseUnits(half.legs) }))
      : null,
  };
}

// Builds the WHERE for the union. `params` is mutated: it already holds $1
// (userId) and grows one entry per active filter.
//
// A FOLDED row answers to BOTH of its identities. The other half was suppressed
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
      OR ($${params.length} = 'exchange' AND r.exchange_match IS NOT NULL))`);
  }
  if (category) {
    params.push(category);
    clauses.push(`(r.category = $${params.length} OR r.match_category = $${params.length})`);
  }
  if (needsReview !== null && needsReview !== undefined) {
    // Already ORed across the pair inside each branch, so this needs no second
    // arm: a flagged half raises its host's flag.
    params.push(needsReview);
    clauses.push(`r.needs_review = $${params.length}`);
  }
  // A wallet narrows to that wallet's transactions, folded halves included --
  // they belong to the transaction, so they belong to its wallet. The second
  // arm is the wallet-to-wallet collapse: the RECEIVING wallet's row was folded
  // into the sender's, and testing only the host would make the event vanish
  // from the receiver's view rather than narrow to it.
  if (walletId != null) {
    params.push(walletId);
    clauses.push(`(r.wallet_id = $${params.length} OR $${params.length} = ANY(r.fold_wallet_ids))`);
  }
  if (exchangeAccountId != null) {
    params.push(exchangeAccountId);
    clauses.push(`(r.exchange_account_id = $${params.length} OR r.match_account_id = $${params.length})`);
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

    // COUNT(*) OVER() rides on the returned rows, so an EMPTY page carries no
    // count at all -- and an offset past the end reported total 0 beside a
    // header reading "Showing 0 of 0" for a ledger with three rows in it. The
    // window stays the fast path (one query for every page that has rows); an
    // empty page pays for one scalar count rather than lying.
    let total = result.rows.length ? Number(result.rows[0].total_count) : 0;
    if (!result.rows.length) {
      const counted = await pool.query(
        `${LEDGER_CTE}
         SELECT COUNT(*)::int AS total_count
         FROM ${UNION_SOURCE}
         ${where}`,
        params.slice(0, params.length - 2)
      );
      total = Number(counted.rows[0]?.total_count) || 0;
    }
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
  // the other half's flag ORed in -- so "needs review" in the badge and in the
  // filter can never disagree.
  //
  // No materiality floor, unlike the counterparty triage badge. That one counts
  // a population it cannot drain (an unlabeled dust airdrop is unlabelable in
  // practice), so it needs a floor to reach zero. Every row here is resolvable
  // by hand in two clicks -- an override on the on-chain side, a resolve on the
  // venue side -- so the count already reaches zero, and a floor would only
  // hide rows the user is being asked to explain.
  //
  // `unpriced_count` is the honesty counter for the USD column: a row with no
  // price is NOT worth zero, and a total that quietly omitted it would be a
  // number nobody could reconcile.
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
           + COUNT(*) FILTER (WHERE r.exchange_match IS NOT NULL))::int AS exchange_count,
         (COUNT(*) FILTER (WHERE r.needs_review AND r.source = 'onchain'))::int AS onchain_needs_review,
         (COUNT(*) FILTER (WHERE r.needs_review AND r.source = 'exchange'))::int AS exchange_needs_review,
         (COUNT(*) FILTER (WHERE r.exchange_match IS NOT NULL))::int AS matched_count,
         -- ON-CHAIN only. 043 values eth_transfers, and the unpriced
         -- enumeration this counter sits beside enumerates on-chain assets --
         -- so counting a crypto/crypto venue trade here would make the number
         -- permanently non-zero against a banner that can never name it, which
         -- is the "badge that cannot reach zero" failure again.
         (COUNT(*) FILTER (WHERE r.usd_basis = 'unpriced' AND r.source = 'onchain'))::int AS unpriced_count,
         (COUNT(*) FILTER (WHERE r.usd_basis = 'carried'))::int AS carried_count,
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
      unpriced_count: Number(row.unpriced_count) || 0,
      carried_count: Number(row.carried_count) || 0,
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
module.exports.toBaseUnits = toBaseUnits;
