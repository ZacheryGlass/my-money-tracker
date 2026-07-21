'use strict';

const express = require('express');
const RecurringExpense = require('../models/RecurringExpense');
const IgnoredMerchant = require('../models/IgnoredMerchant');
const MerchantSpend = require('../models/MerchantSpend');
const ExpenseSyncService = require('../services/ExpenseSyncService');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);

router.get('/', async (req, res) => {
  try {
    const expenses = await RecurringExpense.findAll();
    res.status(200).json({ expenses });
  } catch (error) {
    logger.error({ err: error }, 'Get expenses error');
    res.status(500).json({ error: 'Server error retrieving expenses' });
  }
});

router.get('/ignored', async (req, res) => {
  try {
    const ignored = await IgnoredMerchant.all();
    res.status(200).json({ ignored });
  } catch (error) {
    logger.error({ err: error }, 'Get ignored merchants error');
    res.status(500).json({ error: 'Server error retrieving ignored merchants' });
  }
});

// Restoring lifts the ignore and runs a sync so the merchant reappears now
// instead of waiting for the nightly job. The key travels as a query param
// (not a path segment) so merchant names containing '/' survive Azure's
// encoded-slash path filtering. `recreated` tells the client whether the
// merchant still has qualifying recent charges to rebuild a row from.
router.delete('/ignored', async (req, res) => {
  try {
    const merchantKey = req.query.key;
    if (typeof merchantKey !== 'string' || !merchantKey) {
      return res.status(400).json({ error: 'Missing merchant key' });
    }
    await IgnoredMerchant.remove(merchantKey);
    let recreated = false;
    try {
      const result = await ExpenseSyncService.run();
      recreated = [...result.created, ...result.refreshed].some((r) => r.merchantKey === merchantKey || r.name === merchantKey);
    } catch (syncError) {
      // The un-ignore already persisted; the nightly sync will rebuild the row.
      logger.error({ err: syncError }, 'Sync after restore failed');
    }
    res.status(200).json({ restored: merchantKey, recreated });
  } catch (error) {
    logger.error({ err: error }, 'Restore ignored merchant error');
    res.status(500).json({ error: 'Server error restoring merchant' });
  }
});

// Windows the Top Merchants page can ask for. Kept in lockstep with the
// period selector on the frontend.
const MERCHANT_WINDOWS = new Set([30, 60, 90]);

// Top merchants by spend over a trailing window, for the Top Merchants page.
// Ignored merchants are excluded, so the shared Ignored panel governs this
// list the same way it governs recurring expenses. Defined before the /:id
// routes so 'merchants' is never parsed as an expense id.
router.get('/merchants', async (req, res) => {
  try {
    const days = req.query.days === undefined ? 30 : parseInt(req.query.days, 10);
    if (!MERCHANT_WINDOWS.has(days)) {
      return res.status(400).json({ error: 'days must be 30, 60 or 90' });
    }
    const merchants = await MerchantSpend.topForWindow(days);
    res.status(200).json({ merchants, days });
  } catch (error) {
    logger.error({ err: error }, 'Get top merchants error');
    res.status(500).json({ error: 'Server error retrieving merchants' });
  }
});

// A merchant's transactions within the window, for the expandable row on the
// Top Merchants page. The key travels as a query param for the same
// encoded-slash reason as the ignored restore route.
router.get('/merchants/transactions', async (req, res) => {
  try {
    const merchantKey = req.query.key;
    if (typeof merchantKey !== 'string' || !merchantKey) {
      return res.status(400).json({ error: 'Missing merchant key' });
    }
    const days = req.query.days === undefined ? 30 : parseInt(req.query.days, 10);
    if (!MERCHANT_WINDOWS.has(days)) {
      return res.status(400).json({ error: 'days must be 30, 60 or 90' });
    }
    const transactions = await RecurringExpense.chargesForMerchant(merchantKey, 100, days);
    res.status(200).json({ transactions });
  } catch (error) {
    logger.error({ err: error }, 'Get merchant transactions error');
    res.status(500).json({ error: 'Server error retrieving merchant transactions' });
  }
});

// Ignore by merchant key, for the Top Merchants page (most rows there have no
// recurring-expense id to DELETE). Any tracked expense for the merchant is
// dropped too so both pages agree; the shared restore route lifts it back.
router.post('/ignored', async (req, res) => {
  try {
    const { key, name } = req.body || {};
    if (typeof key !== 'string' || !key) {
      return res.status(400).json({ error: 'Missing merchant key' });
    }
    const tracked = await RecurringExpense.deleteByMerchantKey(key);
    await IgnoredMerchant.add(key, {
      name: tracked?.name || (typeof name === 'string' && name) || key,
      lastCost: tracked?.cost ?? null,
    });
    res.status(200).json({ message: 'Merchant ignored', ignoredMerchant: key });
  } catch (error) {
    logger.error({ err: error }, 'Ignore merchant error');
    res.status(500).json({ error: 'Server error ignoring merchant' });
  }
});

// The individual charges behind a tracked expense, for the expandable row on
// the Monthly Expenses page. Returns [] when the expense has no linked merchant.
router.get('/:id/transactions', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid expense id' });
    }
    const expense = await RecurringExpense.findById(id);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    const transactions = expense.merchant_key
      ? await RecurringExpense.chargesForMerchant(expense.merchant_key)
      : [];
    res.status(200).json({ transactions });
  } catch (error) {
    logger.error({ err: error }, 'Get expense transactions error');
    res.status(500).json({ error: 'Server error retrieving expense transactions' });
  }
});

router.patch('/:id/tag', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid expense id' });
    }
    const { tag } = req.body;
    if (tag !== null && typeof tag !== 'string') {
      return res.status(400).json({ error: 'Tag must be a string or null' });
    }
    const trimmed = typeof tag === 'string' ? tag.trim().slice(0, 100) : null;
    const expense = await RecurringExpense.setTag(id, trimmed || null);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.status(200).json({ expense });
  } catch (error) {
    logger.error({ err: error }, 'Set expense tag error');
    res.status(500).json({ error: 'Server error setting tag' });
  }
});

// Ignoring removes the row and records the merchant so the nightly sync won't
// re-create it. A snapshot (name, cost) is kept so the Ignored panel is legible.
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: 'Invalid expense id' });
    }
    const expense = await RecurringExpense.findById(id);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    await RecurringExpense.delete(expense.id);
    if (expense.merchant_key) {
      await IgnoredMerchant.add(expense.merchant_key, { name: expense.name, lastCost: expense.cost });
    }
    res.status(200).json({ message: 'Expense ignored', ignoredMerchant: expense.merchant_key || null });
  } catch (error) {
    logger.error({ err: error }, 'Ignore expense error');
    res.status(500).json({ error: 'Server error ignoring expense' });
  }
});

module.exports = router;
