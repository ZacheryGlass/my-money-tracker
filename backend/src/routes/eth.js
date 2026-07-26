'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const EthWallet = require('../models/EthWallet');
const EthWalletChain = require('../models/EthWalletChain');
const EthTransfer = require('../models/EthTransfer');
const chains = require('../config/chains');
const EthIgnoredToken = require('../models/EthIgnoredToken');
const EthAddressLabel = require('../models/EthAddressLabel');
const EthActivity = require('../models/EthActivity');
const EthReconciliation = require('../models/EthReconciliation');
const AssetPriceHistory = require('../models/AssetPriceHistory');
const EthWalletService = require('../services/EthWalletService');
const EthActivityService = require('../services/EthActivityService');
const logger = require('../config/logger');
const { shortAddress } = require('../utils/ethAddress');

const router = express.Router();

router.use(requireUser);

function statusFor(error) {
  if (error.code === 'ETHERSCAN_NOT_CONFIGURED') return 503;
  if (error.code === 'INVALID_ADDRESS') return 400;
  if (error.code === 'DUPLICATE_WALLET') return 409;
  if (error.code === 'ACCOUNT_NAME_CONFLICT') return 409;
  return 500;
}

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// 'exchange' asserts the counterparty is a venue the user controls funds at, so
// its transfers become internal transfers. 'own' is the user's own untracked
// address (same effect via the own set, no account created). 'external' records
// "reviewed, genuinely a third party" and changes no classification at all.
const LABEL_KINDS = new Set(['exchange', 'external', 'own']);

// The activity layer's category vocabulary, single-sourced from the service so
// the route and the CHECK constraint in 038 can never drift apart.
const ACTIVITY_CATEGORIES = new Set(EthActivityService.CATEGORIES);

const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;

// How the activity feed treats quarantined spam (#74). The default hides it --
// that IS the quarantine -- and 'only' is the Spam filter. Fail-closed like
// every other filter here: `?spam=hide` silently returning the default feed
// would read as "nothing was quarantined".
const SPAM_FILTERS = new Set(['exclude', 'only', 'all']);

// The stored verdicts of the balance audit, as the reconciliation route filters
// them. 'match'/'dust' are the two "nothing to do here" verdicts.
const RECONCILIATION_STATUSES = new Set(['match', 'dust', 'mismatch', 'skipped', 'unavailable']);

// One wallet's audit, shaped for the wallet card.
//
// `needs_review` is native-only on purpose. A nonzero ETH delta is a hard signal
// of a missed movement -- blob fees, a self-destruct credit, a validator payout,
// an unsynced feed -- while a token delta has entirely benign explanations
// (rebasing supply, fee-on-transfer). Badging both would put a permanent number
// on every wallet that ever touched a rebasing token, and a badge that cannot
// reach zero gets ignored, which would cost us the ETH signal too.
function buildReconciliationSummary(counts, issues) {
  if (!counts) return null;
  return {
    checked_at: counts.checked_at,
    assets_checked: counts.assets_checked,
    matched: counts.matched,
    dust: counts.dust,
    mismatched: counts.mismatched,
    native_mismatches: counts.native_mismatches,
    skipped: counts.skipped,
    unavailable: counts.unavailable,
    needs_review: counts.native_mismatches > 0,
    // Capped by the model; say so rather than letting a truncated list read as
    // the whole story.
    issues: issues || [],
    truncated: (issues?.length || 0) < (counts.mismatched + counts.skipped + counts.unavailable),
  };
}

// Resolves a wallet id from a request against the caller. Returns
// { ok: false } when the id is absent-but-required, unparseable, or somebody
// else's -- all three are a 404, so a foreign id is indistinguishable from a
// made-up one.
async function loadWallet(req, rawId, { required }) {
  if (rawId === undefined || rawId === null || rawId === '') {
    return required ? { ok: false } : { ok: true, walletId: null };
  }
  const walletId = parseId(rawId);
  const wallet = walletId && await EthWallet.findByIdForUser(walletId, req.user.id);
  if (!wallet) return { ok: false };
  return { ok: true, walletId };
}

router.post('/wallets', async (req, res) => {
  try {
    const { address, label } = req.body || {};
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }

    const { wallet, account } = await EthWalletService.addWallet(req.user.id, address, label);

    // First sync of a busy wallet can outlive proxy timeouts (and the axios
    // interceptor would retry the POST, hitting DUPLICATE_WALLET), so it runs
    // in the background; failures land on the wallet's error_code for the
    // Settings badge and Sync retry.
    EthWalletService.syncWallet(wallet.id).catch((err) => {
      logger.error({ walletId: wallet.id, err }, 'Initial ETH wallet sync failed');
    });

    res.status(201).json({ wallet, account, syncStarted: true });
  } catch (error) {
    logger.error({ err: error }, 'Add ETH wallet error');
    const status = statusFor(error);
    res.status(status).json({ error: status === 500 ? 'Failed to add wallet' : error.message });
  }
});

router.get('/wallets', async (req, res) => {
  try {
    const wallets = await EthWallet.findAllByUser(req.user.id);
    const walletIds = wallets.map((w) => w.id);
    // One batch read instead of a per-wallet query inside the map below.
    const allChainStates = await EthWalletChain.findAllForWallets(walletIds);
    const chainStatesByWallet = new Map();
    for (const state of allChainStates) {
      const list = chainStatesByWallet.get(state.wallet_id) || [];
      list.push(state);
      chainStatesByWallet.set(state.wallet_id, list);
    }
    // The balance audit rides along on the wallet status API, batched for the
    // same reason the chain rows are: a summary fetched per wallet inside the
    // map below is the N+1 this route already went out of its way to avoid.
    const [reconciliationByWallet, reconciliationIssues] = await Promise.all([
      EthReconciliation.summaryForWallets(req.user.id, walletIds),
      EthReconciliation.openIssuesForWallets(req.user.id, walletIds),
    ]);
    const withAccounts = await Promise.all(
      wallets.map(async (wallet) => {
        const chainStates = chainStatesByWallet.get(wallet.id) || [];
        const [account, ethQuantity] = await Promise.all([
          EthWallet.getAccountForWallet(wallet.id),
          EthWallet.getEthQuantity(wallet.id),
        ]);
        return {
          ...wallet,
          account: account || null,
          // Summed across chains -- see EthWallet.getEthQuantity.
          eth_quantity: ethQuantity,
          // Per-chain sync state. Carries the gaps the wallet-level badge
          // deliberately does NOT carry: a feed (or a whole chain) this
          // Etherscan key cannot serve is a standing condition, so it is
          // reported here instead of pinning the attention badge forever.
          // `enabled` is the live registry answer, not stored state, so a
          // switched-off chain shows as such while keeping its history.
          chains: chainStates.map((state) => ({
            ...state,
            name: chains.chainLabel(state.chain_id),
            enabled: chains.isEnabled(state.chain_id),
          })),
          // Does the stored transfer ledger reproduce the balance the chain
          // reports? `null` until the wallet has been audited at least once,
          // which is distinct from an audit that found nothing wrong.
          reconciliation: buildReconciliationSummary(
            reconciliationByWallet.get(wallet.id),
            reconciliationIssues.get(wallet.id)
          ),
        };
      })
    );
    res.status(200).json({ wallets: withAccounts });
  } catch (error) {
    logger.error({ err: error }, 'Get ETH wallets error');
    res.status(500).json({ error: 'Failed to retrieve wallets' });
  }
});

router.post('/wallets/:id/sync', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const wallet = await EthWallet.findByIdForUser(id, req.user.id);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const result = await EthWalletService.syncWallet(id);
    const updated = await EthWallet.findById(id);

    res.status(200).json({ wallet: updated, sync: result });
  } catch (error) {
    logger.error({ err: error, walletId: req.params.id }, 'Sync ETH wallet error');
    if (error.code === 'ETHERSCAN_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to sync wallet' });
  }
});

router.delete('/wallets/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const wallet = await EthWallet.findByIdForUser(id, req.user.id);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const removeData = req.query.removeData === 'true';
    await EthWalletService.removeWallet(id, { removeData });
    res.status(200).json({ message: 'Wallet disconnected successfully' });
  } catch (error) {
    logger.error({ err: error, walletId: req.params.id }, 'Remove ETH wallet error');
    res.status(500).json({ error: 'Failed to disconnect wallet' });
  }
});

// The on-chain activity feed. Covers every wallet the user owns by default;
// `wallet_id` narrows it to one. Each row carries its own wallet_address, so a
// merged feed can still say which address sent or received.
router.get('/transfers', async (req, res) => {
  try {
    let walletId = null;
    if (req.query.wallet_id !== undefined) {
      walletId = parseId(req.query.wallet_id);
      // Verified against the caller before querying: an unowned or unparseable
      // id must 404 rather than silently widening the feed to every wallet.
      const wallet = walletId && await EthWallet.findByIdForUser(walletId, req.user.id);
      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const { transfers, total } = await EthTransfer.findForUser(req.user.id, {
      walletId,
      type: req.query.type,
      limit,
      offset,
    });

    res.status(200).json({ data: transfers, pagination: { total, limit, offset } });
  } catch (error) {
    logger.error({ err: error, walletId: req.query.wallet_id }, 'Get ETH transfers error');
    res.status(500).json({ error: 'Failed to retrieve transfers' });
  }
});

// The transaction-level activity feed: one row per transaction per owning
// wallet, each either confidently categorized or flagged with a reason. Manual
// overrides are resolved over the derived verdict inside the query, so a
// corrected row reads and filters as the category the user chose.
router.get('/activity', async (req, res) => {
  try {
    const wallet = await loadWallet(req, req.query.wallet_id, { required: false });
    if (!wallet.ok) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    // Unlike the transfers route's `type`, an unknown category is a 400 rather
    // than being ignored. A filter that silently returns the UNFILTERED feed
    // reads as "there is nothing else", which is the opposite of what a filter
    // for a review queue must promise.
    let category = null;
    if (req.query.category !== undefined && req.query.category !== '') {
      category = String(req.query.category).trim().toLowerCase();
      if (!ACTIVITY_CATEGORIES.has(category)) {
        return res.status(400).json({ error: `Unknown category '${category}'` });
      }
    }

    // Same fail-closed rule as `category`, for the same reason: `?needs_review=yes`
    // silently returning the whole feed reads as "nothing needs review".
    // 'true'/'false' is the spelling every other boolean query param in the app
    // uses (include_hidden, include_dust, removeData).
    let needsReview = null;
    if (req.query.needs_review !== undefined && req.query.needs_review !== '') {
      const raw = String(req.query.needs_review).trim().toLowerCase();
      if (raw !== 'true' && raw !== 'false') {
        return res.status(400).json({ error: "needs_review must be 'true' or 'false'" });
      }
      needsReview = raw === 'true';
    }

    // Quarantined spam is hidden by default and reachable with ?spam=only.
    // Unknown values 400 for the same reason the two filters above do.
    let spam = 'exclude';
    if (req.query.spam !== undefined && req.query.spam !== '') {
      spam = String(req.query.spam).trim().toLowerCase();
      if (!SPAM_FILTERS.has(spam)) {
        return res.status(400).json({ error: `spam must be one of: ${[...SPAM_FILTERS].join(', ')}` });
      }
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { activity, total } = await EthActivity.findForUser(req.user.id, {
      walletId: wallet.walletId,
      category,
      needsReview,
      spam,
      limit,
      offset,
    });

    // How many rows the default view is hiding, alongside the review count. A
    // quarantine that never says how much it swallowed is indistinguishable
    // from a sync that never fetched anything.
    //
    // Scoped to the SAME wallet as `data`, like the reconciliation route's:
    // a headline that totals every wallet above wallet-filtered rows reads as
    // hidden rows on the wallet in front of you.
    const summary = await EthActivity.summaryForUser(req.user.id, { walletId: wallet.walletId });

    res.status(200).json({
      data: activity,
      summary: { spam_count: summary.spamCount, needs_review_count: summary.needsReviewCount },
      pagination: { total, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get ETH activity error');
    res.status(500).json({ error: 'Failed to retrieve activity' });
  }
});

// The assets in this user's on-chain history that no provider will price.
//
// The point of the endpoint is that "unpriced" is ENUMERABLE. A dead
// EtherDelta-era token has no series anywhere, and the honest answer for its
// rows is "not known", not $0 -- but an unexplained blank is only honest if the
// user can ask what is behind it. Each entry carries the provider's own verdict
// from asset_price_coverage (unlisted / range_limited / error / pending), so
// "CoinGecko has never heard of this contract" is distinguishable from "your
// API plan stops at 365 days", which is a fixable problem.
//
// Prices are global market data; WHICH assets a person holds is not, so this
// reads through the user-scoped, fail-closed model entry point.
//
// NO UI CONSUMER YET. The unified ledger (#63) is the screen that surfaces
// usd_value / usd_basis / the unpriced list together; until it lands this is
// reachable only by hand. Deliberate, and stated here rather than implied: the
// enumeration is what makes "unpriced, not $0" checkable today, and #63 is
// where it becomes visible.
router.get('/prices/unpriced', async (req, res) => {
  try {
    const assets = await AssetPriceHistory.unpricedAssetsForUser(req.user.id);
    res.status(200).json({ data: assets, total: assets.length });
  } catch (error) {
    logger.error({ err: error }, 'Get unpriced assets error');
    res.status(500).json({ error: 'Failed to retrieve unpriced assets' });
  }
});

// A manual correction. Stored in its own table so the nightly rebuild cannot
// erase it; every reader coalesces it over the derived verdict.
router.post('/activity/override', async (req, res) => {
  try {
    const { wallet_id: walletIdRaw, tx_hash: txHashRaw, category: categoryRaw, note, chain_id: chainIdRaw } = req.body || {};

    const wallet = await loadWallet(req, walletIdRaw, { required: true });
    if (!wallet.ok) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    if (typeof txHashRaw !== 'string' || !TX_HASH_RE.test(txHashRaw.trim())) {
      return res.status(400).json({ error: 'tx_hash must be a 0x-prefixed 64-hex-character transaction hash' });
    }
    // Any positive integer, not just enabled chains: rows from a since-disabled
    // chain stay stored, so their corrections must stay writable.
    const chainId = chainIdRaw === undefined || chainIdRaw === null ? chains.DEFAULT_CHAIN_ID : Number(chainIdRaw);
    if (!Number.isInteger(chainId) || chainId < 1) {
      return res.status(400).json({ error: 'chain_id must be a positive integer' });
    }
    if (typeof categoryRaw !== 'string') {
      return res.status(400).json({ error: 'category is required' });
    }
    const category = categoryRaw.trim().toLowerCase();
    if (!ACTIVITY_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category must be one of: ${[...ACTIVITY_CATEGORIES].join(', ')}` });
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(400).json({ error: 'note must be a string' });
    }

    const txHash = txHashRaw.trim().toLowerCase();

    // A correction must target something the user can see. Every reader joins
    // activity -> override, so an override written for a well-formed hash with
    // no activity row is stored and then invisible forever -- saved, silently
    // inert, and impossible to notice.
    const targetExists = await EthActivity.overrideTargetExists(req.user.id, wallet.walletId, txHash, { chainId });
    if (!targetExists) {
      return res.status(404).json({ error: 'No activity found for that transaction on this wallet' });
    }

    const override = await EthActivity.upsertOverride(
      req.user.id,
      wallet.walletId,
      txHash,
      { category, note: note?.trim() || null, chainId }
    );
    // The model's wallet join is the second ownership gate; a null here means
    // the wallet vanished between the check and the write.
    if (!override) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    res.status(201).json({ override });
  } catch (error) {
    logger.error({ err: error }, 'Set ETH activity override error');
    res.status(500).json({ error: 'Failed to save the override' });
  }
});

// The one-click un-quarantine (and its inverse, marking something as spam by
// hand). Stored in the same overrides table as a category correction, so it
// survives every rebuild -- and separately from it, because "this is not junk"
// and "this was actually a purchase" are two different statements.
//
// Nothing is deleted either way: `spam: true` on a real transfer hides it from
// the default feed and the triage queue and nowhere else. Its legs, its dollars
// and its eth_transfers rows are untouched, so the balance audit still sees
// every wei that moved.
router.post('/activity/spam', async (req, res) => {
  try {
    const { wallet_id: walletIdRaw, tx_hash: txHashRaw, chain_id: chainIdRaw, spam } = req.body || {};

    const wallet = await loadWallet(req, walletIdRaw, { required: true });
    if (!wallet.ok) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    if (typeof txHashRaw !== 'string' || !TX_HASH_RE.test(txHashRaw.trim())) {
      return res.status(400).json({ error: 'tx_hash must be a 0x-prefixed 64-hex-character transaction hash' });
    }
    const chainId = chainIdRaw === undefined || chainIdRaw === null ? chains.DEFAULT_CHAIN_ID : Number(chainIdRaw);
    if (!Number.isInteger(chainId) || chainId < 1) {
      return res.status(400).json({ error: 'chain_id must be a positive integer' });
    }
    // Explicit boolean only. Coercing 'false' -- which is what a query-string
    // habit produces -- would quarantine the row the user was rescuing.
    if (typeof spam !== 'boolean') {
      return res.status(400).json({ error: 'spam must be true or false' });
    }

    const txHash = txHashRaw.trim().toLowerCase();

    // Same trap as the category override: every reader joins activity ->
    // override, so a verdict written against a hash this wallet never saw is
    // stored and then invisible forever.
    const targetExists = await EthActivity.overrideTargetExists(req.user.id, wallet.walletId, txHash, { chainId });
    if (!targetExists) {
      return res.status(404).json({ error: 'No activity found for that transaction on this wallet' });
    }

    const override = await EthActivity.setSpamOverride(req.user.id, wallet.walletId, txHash, { spam, chainId });
    if (!override) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    res.status(201).json({ override });
  } catch (error) {
    logger.error({ err: error }, 'Set ETH activity spam verdict error');
    res.status(500).json({ error: 'Failed to save the spam verdict' });
  }
});

// Undoing a correction uncovers the derived verdict again -- the override is
// deliberately not a one-way door.
router.delete('/activity/override', async (req, res) => {
  try {
    const wallet = await loadWallet(req, req.query.wallet_id, { required: true });
    if (!wallet.ok) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const txHash = typeof req.query.tx_hash === 'string' ? req.query.tx_hash.trim().toLowerCase() : '';
    if (!TX_HASH_RE.test(txHash)) {
      return res.status(400).json({ error: 'tx_hash must be a 0x-prefixed 64-hex-character transaction hash' });
    }
    const chainId = req.query.chain_id === undefined ? chains.DEFAULT_CHAIN_ID : Number(req.query.chain_id);
    if (!Number.isInteger(chainId) || chainId < 1) {
      return res.status(400).json({ error: 'chain_id must be a positive integer' });
    }

    const removed = await EthActivity.deleteOverride(req.user.id, wallet.walletId, txHash, { chainId });
    if (!removed) {
      return res.status(404).json({ error: 'Override not found' });
    }
    // This drops the whole correction, the spam verdict included -- they live
    // on one row, and "forget what I said about this transaction" is a coherent
    // unit. But an un-quarantine dropped here UNCOVERS the derived spam verdict
    // again, so the transaction can vanish from the default feed as a side
    // effect of an action about its category. Say so rather than answering a
    // bare "removed": a rescue undone in silence is the failure this whole
    // feature exists to avoid. Re-rescue with POST /activity/spam.
    res.status(200).json({
      message: removed.spam === false
        ? 'Override removed. This also dropped the "not spam" verdict, so the automatic quarantine applies again.'
        : 'Override removed',
      dropped_spam_verdict: removed.spam ?? null,
    });
  } catch (error) {
    logger.error({ err: error }, 'Remove ETH activity override error');
    res.status(500).json({ error: 'Failed to remove the override' });
  }
});

// The full balance audit: every (wallet, chain, asset) the ledger has been
// compared on, worst verdict first. The wallets route carries a capped summary
// for the wallet card; this is the unabridged version.
router.get('/reconciliation', async (req, res) => {
  try {
    const wallet = await loadWallet(req, req.query.wallet_id, { required: false });
    if (!wallet.ok) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    // Fail-closed like the activity route's category filter, and for the same
    // reason: `?status=drift` silently returning every row -- matched ones
    // included -- reads as "nothing drifted", which is the opposite of what a
    // filter on an audit must promise.
    let status = null;
    if (req.query.status !== undefined && req.query.status !== '') {
      status = String(req.query.status).trim().toLowerCase();
      if (!RECONCILIATION_STATUSES.has(status)) {
        return res.status(400).json({ error: `Unknown status '${status}'` });
      }
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows, total } = await EthReconciliation.findForUser(req.user.id, {
      walletId: wallet.walletId,
      status,
      limit,
      offset,
    });
    // Scoped to the same wallet as `data`. A headline that totals every wallet
    // above rows filtered to one of them is a number nobody can reconcile with
    // what they are looking at -- and it reads as drift on the wallet on screen.
    const summary = await EthReconciliation.summaryForUser(req.user.id, {
      walletId: wallet.walletId,
    });

    res.status(200).json({
      data: rows.map((row) => ({ ...row, chain_name: chains.chainLabel(row.chain_id) })),
      summary: {
        native_mismatches: summary.nativeMismatches,
        token_mismatches: summary.tokenMismatches,
        unchecked: summary.unchecked,
        assets_checked: summary.assetsChecked,
        checked_at: summary.checkedAt,
      },
      pagination: { total, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get ETH reconciliation error');
    res.status(500).json({ error: 'Failed to retrieve the balance audit' });
  }
});

router.get('/ignored-tokens', async (req, res) => {
  try {
    const tokens = await EthIgnoredToken.findAll(req.user.id);
    res.status(200).json({ tokens });
  } catch (error) {
    logger.error({ err: error }, 'Get ignored tokens error');
    res.status(500).json({ error: 'Failed to retrieve ignored tokens' });
  }
});

router.post('/ignored-tokens', async (req, res) => {
  try {
    const { contract_address, symbol, note } = req.body || {};
    if (!contract_address || !/^0x[0-9a-f]{40}$/i.test(contract_address.trim())) {
      return res.status(400).json({ error: 'contract_address must be a 0x-prefixed 40-hex-character address' });
    }

    const token = await EthIgnoredToken.upsert(req.user.id, contract_address.trim(), symbol, note);
    await EthWalletService.refreshDerivedForUser(req.user.id);
    res.status(201).json({ token });
  } catch (error) {
    logger.error({ err: error }, 'Ignore token error');
    res.status(500).json({ error: 'Failed to ignore token' });
  }
});

router.delete('/ignored-tokens/:contract', async (req, res) => {
  try {
    const token = await EthIgnoredToken.delete(req.user.id, req.params.contract);
    if (!token) {
      return res.status(404).json({ error: 'Ignored token not found' });
    }
    await EthWalletService.refreshDerivedForUser(req.user.id);
    res.status(200).json({ message: 'Token unignored' });
  } catch (error) {
    logger.error({ err: error }, 'Unignore token error');
    res.status(500).json({ error: 'Failed to unignore token' });
  }
});

router.get('/address-labels', async (req, res) => {
  try {
    const labels = await EthAddressLabel.findAllForUser(req.user.id);
    res.status(200).json({ labels });
  } catch (error) {
    logger.error({ err: error }, 'Get address labels error');
    res.status(500).json({ error: 'Failed to retrieve address labels' });
  }
});

router.post('/address-labels', async (req, res) => {
  try {
    const { address, name, note } = req.body || {};
    if (!address || !/^0x[0-9a-f]{40}$/i.test(address.trim())) {
      return res.status(400).json({ error: 'address must be a 0x-prefixed 40-hex-character address' });
    }
    // Omitted kind passes NULL, which preserves an existing row's verdict and
    // only defaults to 'exchange' on insert. A rename must never re-vote: a
    // caller that sends just {address, name} for an address already marked
    // 'own' would otherwise flip it to 'exchange' and turn a self-transfer
    // into a phantom exchange deposit. Explicit non-strings are rejected
    // rather than coerced, so ["own"] does not slip past the allowlist.
    let kind = null;
    if (req.body?.kind !== undefined) {
      if (typeof req.body.kind !== 'string') {
        return res.status(400).json({ error: "kind must be 'exchange', 'external', or 'own'" });
      }
      kind = req.body.kind.trim().toLowerCase();
      if (!LABEL_KINDS.has(kind)) {
        return res.status(400).json({ error: "kind must be 'exchange', 'external', or 'own'" });
      }
    }

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (trimmedName.length > 64) {
      return res.status(400).json({ error: 'name must be 64 characters or fewer' });
    }
    // Asymmetric on purpose. An 'exchange' name becomes counterparty_exchange:
    // it is both the user-facing text in the ledger AND the assertion that
    // turns real spending into an internal transfer, so it must be typed
    // deliberately. The other kinds never surface their name in
    // classification, so a short-address fallback is enough to triage in one
    // tap. An omitted kind is held to the same bar as 'exchange', since on a
    // fresh row that is what it becomes.
    if (kind !== 'external' && kind !== 'own' && !trimmedName) {
      return res.status(400).json({ error: 'name is required (max 64 characters)' });
    }
    const normalized = address.trim().toLowerCase();
    const labelName = trimmedName || shortAddress(normalized);

    const label = await EthAddressLabel.upsert(req.user.id, normalized, labelName, note, kind);
    await EthWalletService.refreshClassificationsForUser(req.user.id);
    res.status(201).json({ label });
  } catch (error) {
    logger.error({ err: error }, 'Label address error');
    res.status(500).json({ error: 'Failed to label address' });
  }
});

// The triage queue: addresses the user has transacted with but never given a
// verdict on. Query params are clamped rather than 400'd, matching the transfers
// route -- junk input degrades to the default instead of failing the page.
router.get('/counterparties/unreviewed', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rawMin = Number.parseFloat(req.query.min_usd);
    const minUsd = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : EthTransfer.DEFAULT_MIN_USD;
    const includeDust = req.query.include_dust === 'true';

    const { counterparties, total, materialCount, dustCount, materialUsd } =
      await EthTransfer.unreviewedCounterparties(req.user.id, { limit, offset, minUsd, includeDust });

    res.status(200).json({
      data: counterparties,
      // summary.count is the attention badge: material counterparties only, so
      // it can actually reach zero. A badge that never clears gets ignored,
      // which would also destroy its value for wallet sync errors.
      summary: { count: materialCount, dust_count: dustCount, usd_volume: materialUsd, min_usd: minUsd },
      pagination: { total, limit, offset },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get unreviewed counterparties error');
    res.status(500).json({ error: 'Failed to retrieve unreviewed counterparties' });
  }
});

router.delete('/address-labels/:address', async (req, res) => {
  try {
    const label = await EthAddressLabel.delete(req.user.id, req.params.address);
    if (!label) {
      // Distinguish "builtin, refused" from "no such label": deleting a
      // builtin would only resurrect it when the seed migration re-runs.
      const existing = await EthAddressLabel.findByAddress(req.user.id, req.params.address);
      if (existing) {
        return res.status(409).json({
          error: "Built-in labels can't be removed. Relabel the address to rename it, or mark it as an outside party to stop treating it as an exchange.",
        });
      }
      return res.status(404).json({ error: 'Address label not found' });
    }
    await EthWalletService.refreshClassificationsForUser(req.user.id);
    res.status(200).json({ message: 'Address label removed' });
  } catch (error) {
    logger.error({ err: error }, 'Unlabel address error');
    res.status(500).json({ error: 'Failed to remove address label' });
  }
});

module.exports = router;
