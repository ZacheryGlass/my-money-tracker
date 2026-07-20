'use strict';

const express = require('express');
const RecurringExpense = require('../models/RecurringExpense');
const IgnoredMerchant = require('../models/IgnoredMerchant');
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

router.patch('/:id/tag', async (req, res) => {
  try {
    const { tag } = req.body;
    if (tag !== null && typeof tag !== 'string') {
      return res.status(400).json({ error: 'Tag must be a string or null' });
    }
    const trimmed = typeof tag === 'string' ? tag.trim().slice(0, 100) : null;
    const expense = await RecurringExpense.setTag(parseInt(req.params.id), trimmed || null);
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
    const expense = await RecurringExpense.findById(parseInt(req.params.id));
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

// Restoring lifts the ignore and runs a sync so the merchant reappears now
// instead of waiting for the nightly job.
router.delete('/ignored/:merchantKey', async (req, res) => {
  try {
    const merchantKey = req.params.merchantKey;
    await IgnoredMerchant.remove(merchantKey);
    await ExpenseSyncService.run();
    res.status(200).json({ restored: merchantKey });
  } catch (error) {
    logger.error({ err: error }, 'Restore ignored merchant error');
    res.status(500).json({ error: 'Server error restoring merchant' });
  }
});

module.exports = router;
