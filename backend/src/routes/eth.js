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

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.post('/wallets', async (req, res) => {
  try {
    const { address, label } = req.body || {};
    if (!address) {
      return res.status(400).json({ error: 'address is required' });
    }

    const { wallet, account } = await EthWalletService.addWallet(address, label);

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
    const wallets = await EthWallet.findAll();
    const withAccounts = await Promise.all(
      wallets.map(async (wallet) => {
        const [account, ethQuantity] = await Promise.all([
          EthWallet.getAccountForWallet(wallet.id),
          EthWallet.getEthQuantity(wallet.id),
        ]);
        return { ...wallet, account: account || null, eth_quantity: ethQuantity };
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
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
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
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const wallet = await EthWallet.findById(id);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const { transfers, total } = await EthTransfer.findByWallet(id, {
      type: req.query.type,
      limit,
      offset,
    });

    res.status(200).json({ data: transfers, wallet_address: wallet.address, pagination: { total, limit, offset } });
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

router.post('/ignored-tokens', async (req, res) => {
  try {
    const { contract_address, symbol, note } = req.body || {};
    if (!contract_address || !/^0x[0-9a-f]{40}$/i.test(contract_address.trim())) {
      return res.status(400).json({ error: 'contract_address must be a 0x-prefixed 40-hex-character address' });
    }

    const token = await EthIgnoredToken.upsert(contract_address.trim(), symbol, note);
    await EthWalletService.refreshAllDerived();
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
    await EthWalletService.refreshAllDerived();
    res.status(200).json({ message: 'Token unignored' });
  } catch (error) {
    logger.error({ err: error }, 'Unignore token error');
    res.status(500).json({ error: 'Failed to unignore token' });
  }
});

module.exports = router;
