'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const EthWallet = require('../models/EthWallet');
const EthWalletChain = require('../models/EthWalletChain');
const EthTransfer = require('../models/EthTransfer');
const chains = require('../config/chains');
const EthIgnoredToken = require('../models/EthIgnoredToken');
const EthAddressLabel = require('../models/EthAddressLabel');
const EthWalletService = require('../services/EthWalletService');
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
    const withAccounts = await Promise.all(
      wallets.map(async (wallet) => {
        const [account, ethQuantity, chainStates] = await Promise.all([
          EthWallet.getAccountForWallet(wallet.id),
          EthWallet.getEthQuantity(wallet.id),
          EthWalletChain.findForWallet(wallet.id),
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
