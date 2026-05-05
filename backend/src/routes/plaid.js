'use strict';

const express = require('express');
const authenticateToken = require('../middleware/auth');
const PlaidItem = require('../models/PlaidItem');
const PlaidService = require('../services/PlaidService');
const logger = require('../config/logger');

const router = express.Router();

router.use(authenticateToken);

router.post('/link-token', async (req, res) => {
  try {
    const linkToken = await PlaidService.createLinkToken(req.user.id);
    res.status(200).json({ link_token: linkToken });
  } catch (error) {
    logger.error({ err: error }, 'Create link token error');
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

router.post('/exchange-token', async (req, res) => {
  try {
    const { public_token } = req.body;
    if (!public_token) {
      return res.status(400).json({ error: 'public_token is required' });
    }

    const item = await PlaidService.exchangePublicToken(public_token);
    const syncResult = await PlaidService.syncItem(item.id);
    const accounts = await PlaidItem.getAccountsForItem(item.id);

    res.status(201).json({ item, accounts, sync: syncResult });
  } catch (error) {
    logger.error({ err: error }, 'Exchange token error');
    if (error.response?.data?.error_code) {
      return res.status(400).json({
        error: error.response.data.error_message || 'Plaid token exchange failed',
        plaid_error: error.response.data.error_code,
      });
    }
    res.status(500).json({ error: 'Failed to connect account' });
  }
});

router.get('/items', async (req, res) => {
  try {
    const items = await PlaidItem.findAll();
    const itemsWithAccounts = await Promise.all(
      items.map(async (item) => {
        const accounts = await PlaidItem.getAccountsForItem(item.id);
        return { ...item, accounts, access_token: undefined };
      })
    );
    res.status(200).json({ items: itemsWithAccounts });
  } catch (error) {
    logger.error({ err: error }, 'Get Plaid items error');
    res.status(500).json({ error: 'Failed to retrieve connected accounts' });
  }
});

router.post('/items/:id/sync', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = await PlaidItem.findById(id);
    if (!item) {
      return res.status(404).json({ error: 'Plaid item not found' });
    }

    const result = await PlaidService.syncItem(id);
    const updatedItem = await PlaidItem.findById(id);

    res.status(200).json({ item: { ...updatedItem, access_token: undefined }, sync: result });
  } catch (error) {
    logger.error({ err: error, itemId: req.params.id }, 'Sync Plaid item error');
    res.status(500).json({ error: 'Failed to sync account' });
  }
});

router.delete('/items/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = await PlaidItem.findById(id);
    if (!item) {
      return res.status(404).json({ error: 'Plaid item not found' });
    }

    await PlaidService.removeItem(id);
    res.status(200).json({ message: 'Account disconnected successfully' });
  } catch (error) {
    logger.error({ err: error, itemId: req.params.id }, 'Remove Plaid item error');
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

module.exports = router;
