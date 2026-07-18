'use strict';

const express = require('express');
const RecurringExpense = require('../models/RecurringExpense');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

router.use(requireUser);

router.get('/', async (req, res) => {
  try {
    const type = req.query.type || null;
    const expenses = await RecurringExpense.findAll(type);
    res.status(200).json({ expenses });
  } catch (error) {
    logger.error({ err: error }, 'Get expenses error');
    res.status(500).json({ error: 'Server error retrieving expenses' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const summary = await RecurringExpense.getSummary();
    res.status(200).json({ summary });
  } catch (error) {
    logger.error({ err: error }, 'Get expenses summary error');
    res.status(500).json({ error: 'Server error retrieving summary' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { type, name, cost } = req.body;
    if (!type || !name || cost == null) {
      return res.status(400).json({ error: 'Missing required fields: type, name, cost' });
    }
    if (!['bill', 'subscription'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "bill" or "subscription"' });
    }
    const expense = await RecurringExpense.create(req.body);
    res.status(201).json({ expense });
  } catch (error) {
    logger.error({ err: error }, 'Create expense error');
    res.status(500).json({ error: 'Server error creating expense' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const expense = await RecurringExpense.update(parseInt(req.params.id), req.body);
    if (!expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.status(200).json({ expense });
  } catch (error) {
    logger.error({ err: error }, 'Update expense error');
    res.status(500).json({ error: 'Server error updating expense' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await RecurringExpense.delete(parseInt(req.params.id));
    if (!result) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.status(200).json({ message: 'Expense deleted' });
  } catch (error) {
    logger.error({ err: error }, 'Delete expense error');
    res.status(500).json({ error: 'Server error deleting expense' });
  }
});

module.exports = router;
