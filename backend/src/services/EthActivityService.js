'use strict';

// The orchestrating half of the activity layer (#56): every database read and
// write lives here, while the policy surface -- the classification ladder, the
// spam quarantine, the row assembly and the bridge pairing -- lives as pure
// modules under services/ethActivity/. This module re-exports that surface
// unchanged (see the bottom), so requiring EthActivityService keeps working
// for every caller and test that predates the split.

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const EthActivity = require('../models/EthActivity');
const EthActivityLink = require('../models/EthActivityLink');
const ExchangeMatchService = require('./ExchangeMatchService');
const { DEFAULT_CHAIN_ID } = require('../config/chains');
const {
  CATEGORIES, ZERO_ADDRESS, REVIEW_REASONS, SPAM_REASONS, SPAM_DUST_USD,
} = require('../utils/ethActivityVocabulary');
const { buildActivityRows } = require('./ethActivity/rows');
const {
  bridgeMovement, pairBridgeLegs, bridgeAsset,
  BRIDGE_MAX_FEE_BPS, BRIDGE_DEPOSIT_WINDOW_MS, BRIDGE_WITHDRAWAL_WINDOW_MS,
} = require('./ethActivity/bridge');

class EthActivityService {
  // Deterministic full rebuild of one wallet's activity rows. Called after
  // every sync and every classification refresh, exactly like the ledger
  // mirror. Overrides live in their own table and are untouched here.
  //
  // `rebuildMatches: false` is for a caller that is walking EVERY wallet of one
  // user: the match pass is user-wide by design, so running it per wallet
  // repeats the same full re-derivation N times. Such a caller runs it once
  // itself, after the loop -- see EthWalletService.
  static async rebuildForWallet(walletId, { rebuildMatches = true } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    const [
      transfersResult, ignoredResult, labeledResult, ownWalletsResult, coverageResult,
      bridgeAddresses, serviceAddresses,
    ] = await Promise.all([
      pool.query(
        'SELECT * FROM eth_transfers WHERE wallet_id = $1 ORDER BY block_number, id',
        [walletId]
      ),
      pool.query('SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1', [wallet.user_id]),
      // Which counterparties already carry a verdict, in ANY kind -- the same
      // question the triage queue asks, and it has to get the same answer.
      //
      // The user's own rows, plus the builtin rows for addresses THIS WALLET
      // has actually transacted with. The second arm is bounded on purpose: an
      // unrestricted `OR user_id IS NULL` would drag 036's 5,129-address pack
      // into every rebuild. It cannot be dropped either -- 'exchange' and 'own'
      // reach the builder denormalized onto each leg, but 'external' is inert
      // in classification by design, so a builtin 'external' (the pack's 389
      // payment processors and fiat on-ramps) would otherwise reach nothing at
      // all, and a payout from one of them in an unpriced token would be
      // quarantined by a pack row that already says "reviewed third party".
      //
      // `kind` and `user_id` ride along so this one query also yields the
      // own-address set below.
      pool.query(
        // The counterparty set is built ONCE and probed, rather than asked as a
        // correlated EXISTS per label row.
        //
        // The correlated form read better -- "stop at the first matching
        // transfer" -- but the label side is 036's 5,129 rows, so Postgres ran
        // that subquery 5,129 times, and the `OR` across the two address
        // columns made each run a scan. Measured at 16.9s on a 30k-transfer
        // wallet, inside a rebuild that routes/eth.js awaits on every label
        // write and every ignore toggle. The UNION materializes the wallet's
        // distinct counterparties one time (a hashed probe afterwards), and 045
        // adds the (wallet_id, from_address) / (wallet_id, to_address) indexes
        // that make each half an index-only scan.
        `WITH counterparties AS (
             SELECT from_address AS address FROM eth_transfers WHERE wallet_id = $2
              UNION
             SELECT to_address AS address FROM eth_transfers WHERE wallet_id = $2
           )
         SELECT l.address, l.kind, l.user_id
           FROM eth_address_labels l
          WHERE l.user_id = $1
             OR (l.user_id IS NULL
                 AND l.address IN (SELECT address FROM counterparties))`,
        [wallet.user_id, walletId]
      ),
      // Every address the owner has declared theirs, across ALL their wallets --
      // the thing a poisoner most wants to imitate, and invisible to this
      // wallet's own transfers unless the two have transacted.
      pool.query('SELECT address FROM eth_wallets WHERE user_id = $1', [wallet.user_id]),
      // Assets the price providers say have NO series at all. 'range_limited'
      // and 'error' are deliberately excluded: they mean the series does not
      // reach this row, which says nothing about whether the asset has a market.
      pool.query(
        "SELECT asset_key FROM asset_price_coverage WHERE status IN ('unlisted', 'empty')"
      ),
      // The owner's bridge-labeled counterparties (#59), driving rule 3.
      this._bridgeAddressesForUser(wallet.user_id),
      // The owner's swap-service counterparties (046), driving rule 4.
      this._serviceAddressesForUser(wallet.user_id),
    ]);
    const ignoredContracts = new Set(ignoredResult.rows.map((row) => row.contract_address));
    const labeledAddresses = new Set(labeledResult.rows.map((row) => row.address));
    const ownAddresses = [
      ...ownWalletsResult.rows.map((row) => row.address),
      // 'own' is STRICTLY user-scoped with no builtin fallback -- a global "this
      // address is yours" row would be nonsense -- so the user_id test here is
      // not redundant with the query's first arm.
      ...labeledResult.rows
        .filter((row) => row.kind === 'own' && row.user_id === wallet.user_id)
        .map((row) => row.address),
    ];

    const unlistedAssets = new Set(coverageResult.rows.map((row) => row.asset_key));

    const rows = buildActivityRows(wallet.address, transfersResult.rows, {
      ignoredContracts, labeledAddresses, ownAddresses, unlistedAssets,
      bridgeAddresses, serviceAddresses,
    });
    await this._nameCounterparties(wallet.user_id, rows);
    const written = await EthActivity.replaceForWallet(walletId, rows);

    // The exchange matching pass (#61), re-derived here for the same reason the
    // rows above are: it is a claim about these rows, and eth_activity is
    // delete-then-insert, so any match written earlier was cascaded away by the
    // DELETE that just ran. It also OWNS the needs_review flag on the two
    // exchange categories -- an exchange flow with no record behind it is the
    // thing the issue wants surfaced -- so it has to run after the ladder, not
    // inside it. Non-fatal: a sync that fetched every transfer must not report
    // failure because a derived side table could not be refreshed.
    const matches = rebuildMatches
      ? await ExchangeMatchService.rebuildForUserSafely(wallet.user_id, { walletId })
      : null;

    logger.info({ walletId, activity: written }, 'ETH activity rebuilt');
    return { activity: written, matches };
  }

  // The owner's addresses carrying one label kind, precedence already resolved.
  //
  // The DISTINCT ON picks the winning row per address (user shadows builtin,
  // ORDER BY user_id NULLS LAST) and the kind test sits OUTSIDE it -- the same
  // shape as EthAddressLabel.findAllForUser, and for the same reason. Filtering
  // on kind INSIDE would drop a user's 'external' override out of the candidate
  // set and let the builtin row it was written to overrule resurface underneath
  // it, which is exactly how a correction stops working.
  //
  // 'own' beating these needs nothing here: kind is one column on the winning
  // row, so an address the user declared theirs is simply not in the set (and
  // rule 1 claims the transaction before either rung anyway).
  //
  // NOT derived from the labeledAddresses query above, which deliberately
  // returns BOTH the user row and the builtin row for an address so the spam
  // gate can ask "has this been judged at all". Reading a kind off that
  // unresolved set would let a builtin verdict outvote the user's override.
  static async _addressesOfKindForUser(userId, kind) {
    const result = await pool.query(
      `SELECT address FROM (
         SELECT DISTINCT ON (address) address, kind
         FROM eth_address_labels
         WHERE user_id = $1 OR user_id IS NULL
         ORDER BY address, user_id NULLS LAST
       ) resolved
       WHERE kind = $2`,
      [userId, kind]
    );
    return new Set(result.rows.map((row) => row.address));
  }

  static _bridgeAddressesForUser(userId) {
    return this._addressesOfKindForUser(userId, 'bridge');
  }

  static _serviceAddressesForUser(userId) {
    return this._addressesOfKindForUser(userId, 'service');
  }

  // Pairs each bridge_out with the bridge_in that completes it, across chains
  // and across every wallet the user owns -- a bridge from one of their
  // addresses to another is still one movement.
  //
  // DERIVED WHOLESALE, like eth_activity itself: the links are recomputed from
  // the current rows every time, never patched. That is what makes them
  // self-healing -- rebuilding wallet A cascades away any link that pointed at
  // one of its rows (ON DELETE CASCADE), and re-running this restores the ones
  // that are still true. It also means the review flag has to be re-asserted in
  // BOTH directions below: a leg matched an hour ago can be orphaned by a
  // resync of the wallet on the other side, and leaving it unflagged would
  // claim a completed transfer that no longer has a far side.
  //
  // Per USER, not per wallet, because the two legs of one bridge can sit on two
  // different wallet rows. Callers run it once after the per-wallet rebuilds.
  static async matchBridgeTransfersForUser(userId) {
    if (!userId) throw new Error('EthActivityService.matchBridgeTransfersForUser requires a userId');

    // The RESOLVED category, never the derived one. Every other reader
    // COALESCEs eth_activity_overrides over eth_activity (EthActivity's
    // RESOLVED_COLUMNS), and a matcher that skipped that would keep pairing a
    // transaction the user has explicitly re-categorized as a plain send --
    // handing it a link, and silently un-flagging the far side on the strength
    // of a verdict the user withdrew. It reads the other way too: a row the user
    // overrode INTO bridge_out becomes matchable, which is the same rule.
    const { rows } = await pool.query(
      `SELECT a.id, a.chain_id, a.block_time,
              COALESCE(o.category, a.category) AS category, a.legs
       FROM eth_activity a
       JOIN eth_wallets w ON w.id = a.wallet_id
       LEFT JOIN eth_activity_overrides o
         ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
       WHERE w.user_id = $1
         AND COALESCE(o.category, a.category) IN ('bridge_out', 'bridge_in')
       -- Time first: block_number is a per-chain sequence (039) and means
       -- nothing across chains, and the greedy pairing below depends on both
       -- sides being in true chronological order. The rest of the key only
       -- makes the order total, so a rebuild cannot reshuffle equal timestamps.
       ORDER BY a.block_time, a.chain_id, a.id`,
      [userId]
    );

    const candidates = (direction, category) => rows
      .filter((row) => row.category === category)
      .map((row) => {
        const movement = bridgeMovement(row, direction);
        if (!movement) return null;
        return { id: row.id, chain_id: row.chain_id, ...movement };
      })
      .filter(Boolean);

    const links = pairBridgeLegs(candidates('out', 'bridge_out'), candidates('in', 'bridge_in'));
    const written = await EthActivityLink.replaceForUser(userId, links);
    const flagged = await EthActivityLink.syncBridgeReviewState(userId, REVIEW_REASONS.unmatched_bridge);

    logger.info({ userId, matched: written, unmatched: flagged }, 'ETH bridge legs matched');
    return { matched: written, unmatched: flagged };
  }

  // Fills counterparty_name for display from the owner's labels, resolved with
  // the same precedence as classification: a user row shadows a builtin. An
  // exchange name is already denormalized onto the leg, so those rows keep it.
  static async _nameCounterparties(userId, rows) {
    const pending = [...new Set(
      rows.filter((row) => row.counterparty_address && !row.counterparty_name)
        .map((row) => row.counterparty_address)
    )];
    if (!pending.length) return;

    const result = await pool.query(
      `SELECT DISTINCT ON (address) address, name
       FROM eth_address_labels
       WHERE address = ANY($1::varchar[]) AND (user_id = $2 OR user_id IS NULL)
       ORDER BY address, user_id NULLS LAST`,
      [pending, userId]
    );
    const names = new Map(result.rows.map((row) => [row.address, row.name]));
    for (const row of rows) {
      if (!row.counterparty_name && row.counterparty_address) {
        row.counterparty_name = names.get(row.counterparty_address) || null;
      }
    }
  }
}

module.exports = EthActivityService;
module.exports.buildActivityRows = buildActivityRows;
module.exports.CATEGORIES = CATEGORIES;
module.exports.DEFAULT_CHAIN_ID = DEFAULT_CHAIN_ID;
module.exports.ZERO_ADDRESS = ZERO_ADDRESS;
module.exports.REVIEW_REASONS = REVIEW_REASONS;
module.exports.SPAM_REASONS = SPAM_REASONS;
module.exports.SPAM_DUST_USD = SPAM_DUST_USD;
// The pairing policy, exported pure so every bound (fee tolerance, window,
// direction, cross-chain requirement) is testable without a database.
module.exports.pairBridgeLegs = pairBridgeLegs;
module.exports.bridgeAsset = bridgeAsset;
module.exports.BRIDGE_MAX_FEE_BPS = BRIDGE_MAX_FEE_BPS;
module.exports.BRIDGE_DEPOSIT_WINDOW_MS = BRIDGE_DEPOSIT_WINDOW_MS;
module.exports.BRIDGE_WITHDRAWAL_WINDOW_MS = BRIDGE_WITHDRAWAL_WINDOW_MS;
