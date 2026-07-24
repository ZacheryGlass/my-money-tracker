'use strict';

const express = require('express');
const requireUser = require('../middleware/auth');
const EthWallet = require('../models/EthWallet');
const EthTransfer = require('../models/EthTransfer');
const EthIgnoredToken = require('../models/EthIgnoredToken');
const EthWalletService = require('../services/EthWalletService');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);

function statusFor(error) {
  if (error.code === 'ETHERSCAN_NOT_CONFIGURED') return 503;
  if (error.code === 'INVALID_ADDRESS') return 400;
  if (error.code === 'DUPLICATE_WALLET') return 409;
  return 500;
}

router.post('/wallets', async (req, res) => {
  let created = null;
  try {
    const { address, label } = req.body || {};
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }

    created = await EthWalletService.addWallet(address, label);
    const sync = await EthWalletService.syncWallet(created.wallet.id);
    const wallet = await EthWallet.findById(created.wallet.id);

    res.status(201).json({ wallet, account: created.account, sync });
  } catch (error) {
    logger.error({ err: error }, 'Add ETH wallet error');
    if (created) {
      // The wallet was created but its first sync failed; keep it with the
      // error recorded so the user can retry from Settings.
      const wallet = await EthWallet.findById(created.wallet.id).catch(() => created.wallet);
      return res.status(201).json({ wallet, account: created.account, syncError: error.message });
    }
    const status = statusFor(error);
    res.status(status).json({ error: status === 500 ? 'Failed to add wallet' : error.message });
  }
});

router.get('/wallets', async (req, res) => {
  try {
    const wallets = await EthWallet.findAll();
    const withAccounts = await Promise.all(
      wallets.map(async (wallet) => {
        const account = await EthWallet.getAccountForWallet(wallet.id);
        return { ...wallet, account: account || null };
      })
    );
    res.status(200).json({ wallets: withAccounts });
  } catch (error) {
    logger.error({ err: error }, 'Get ETH wallets error');
    res.status(500).json({ error: 'Failed to retrieve wallets' });
  }
});

router.patch('/wallets/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const wallet = await EthWallet.findById(id);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const updated = await EthWallet.updateLabel(id, req.body?.label);
    res.status(200).json({ wallet: updated });
  } catch (error) {
    logger.error({ err: error, walletId: req.params.id }, 'Update ETH wallet error');
    res.status(500).json({ error: 'Failed to update wallet' });
  }
});

router.post('/wallets/:id/sync', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const wallet = await EthWallet.findById(id);
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
    const id = parseInt(req.params.id);
    const wallet = await EthWallet.findById(id);
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

router.get('/wallets/:id/transfers', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const wallet = await EthWallet.findById(id);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const { transfers, total } = await EthTransfer.findByWallet(id, {
      type: req.query.type,
      limit,
      offset,
    });

    res.status(200).json({ data: transfers, pagination: { total, limit, offset } });
  } catch (error) {
    logger.error({ err: error, walletId: req.params.id }, 'Get ETH transfers error');
    res.status(500).json({ error: 'Failed to retrieve transfers' });
  }
});

router.get('/ignored-tokens', async (req, res) => {
  try {
    const tokens = await EthIgnoredToken.findAll();
    res.status(200).json({ tokens });
  } catch (error) {
    logger.error({ err: error }, 'Get ignored tokens error');
    res.status(500).json({ error: 'Failed to retrieve ignored tokens' });
  }
});

async function refreshAllWalletHoldings() {
  const wallets = await EthWallet.findAll();
  for (const wallet of wallets) {
    try {
      await EthWalletService.refreshHoldings(wallet.id);
    } catch (err) {
      logger.warn({ walletId: wallet.id, err }, 'Holdings refresh after ignore-list change failed');
    }
  }
}

router.post('/ignored-tokens', async (req, res) => {
  try {
    const { contract_address, symbol, note } = req.body || {};
    if (!contract_address || !/^0x[0-9a-f]{40}$/i.test(contract_address.trim())) {
      return res.status(400).json({ error: 'contract_address must be a 0x-prefixed 40-hex-character address' });
    }

    const token = await EthIgnoredToken.upsert(contract_address.trim(), symbol, note);
    await refreshAllWalletHoldings();
    res.status(201).json({ token });
  } catch (error) {
    logger.error({ err: error }, 'Ignore token error');
    res.status(500).json({ error: 'Failed to ignore token' });
  }
});

router.delete('/ignored-tokens/:contract', async (req, res) => {
  try {
    const token = await EthIgnoredToken.delete(req.params.contract);
    if (!token) {
      return res.status(404).json({ error: 'Ignored token not found' });
    }
    await refreshAllWalletHoldings();
    res.status(200).json({ message: 'Token unignored' });
  } catch (error) {
    logger.error({ err: error }, 'Unignore token error');
    res.status(500).json({ error: 'Failed to unignore token' });
  }
});

module.exports = router;
