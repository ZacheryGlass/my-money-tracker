'use strict';

const express = require('express');
const RecurringExpense = require('../models/RecurringExpense');
const IgnoredMerchant = require('../models/IgnoredMerchant');
const { BUDGET_RULES } = require('../services/ExpenseSyncService');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');

// merchant: fields sync nightly from linked transactions; budget: cost is a
// rolling category-spend average; manual: hand-maintained.
function provenanceOf(expense) {
  if (expense.merchant_key) return 'merchant';
  if (BUDGET_RULES[String(expense.name || '').trim().toLowerCase()]) return 'budget';
  return 'manual';
}

const router = express.Router();

router.use(requireUser);

router.get('/', async (req, res) => {
  try {
    const expenses = await RecurringExpense.findAll();
    res.status(200).json({ expenses: expenses.map((e) => ({ ...e, provenance: provenanceOf(e) })) });
  } catch (error) {
    logger.error({ err: error }, 'Get expenses error');
    res.status(500).json({ error: 'Server error retrieving expenses' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, cost } = req.body;
    if (!name || cost == null) {
      return res.status(400).json({ error: 'Missing required fields: name, cost' });
    }
    const expense = await RecurringExpense.create(req.body);
    // Tracking a merchant again is an explicit opt-in; lift any earlier ignore
    // so the sync can link and maintain it.
    await IgnoredMerchant.remove(name);
    res.status(201).json({ expense });
  } catch (error) {
    logger.error({ err: error }, 'Create expense error');
    res.status(500).json({ error: 'Server error creating expense' });
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

router.delete('/:id', async (req, res) => {
  try {
    const expense = await RecurringExpense.findById(parseInt(req.params.id));
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    await RecurringExpense.delete(expense.id);
    // Without this, the next sync would re-create any still-charging merchant.
    if (expense.merchant_key) {
      await IgnoredMerchant.add(expense.merchant_key);
    }
    res.status(200).json({ message: 'Expense deleted', ignoredMerchant: expense.merchant_key || null });
  } catch (error) {
    logger.error({ err: error }, 'Delete expense error');
    res.status(500).json({ error: 'Server error deleting expense' });
  }
});

module.exports = router;
