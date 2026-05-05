'use strict';

const express = require('express');
const SalaryHistory = require('../models/SalaryHistory');
const authenticateToken = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const records = await SalaryHistory.findAll();
    res.status(200).json({ records });
  } catch (error) {
    logger.error({ err: error }, 'Get salary history error');
    res.status(500).json({ error: 'Server error retrieving salary history' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { effective_date, title, salary_amount, total_comp } = req.body;
    if (!effective_date || !title || salary_amount == null || total_comp == null) {
      return res.status(400).json({ error: 'Missing required fields: effective_date, title, salary_amount, total_comp' });
    }
    const record = await SalaryHistory.create(req.body);
    res.status(201).json({ record });
  } catch (error) {
    logger.error({ err: error }, 'Create salary record error');
    res.status(500).json({ error: 'Server error creating salary record' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const record = await SalaryHistory.update(parseInt(req.params.id), req.body);
    if (!record) {
      return res.status(404).json({ error: 'Salary record not found' });
    }
    res.status(200).json({ record });
  } catch (error) {
    logger.error({ err: error }, 'Update salary record error');
    res.status(500).json({ error: 'Server error updating salary record' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await SalaryHistory.delete(parseInt(req.params.id));
    if (!result) {
      return res.status(404).json({ error: 'Salary record not found' });
    }
    res.status(200).json({ message: 'Salary record deleted' });
  } catch (error) {
    logger.error({ err: error }, 'Delete salary record error');
    res.status(500).json({ error: 'Server error deleting salary record' });
  }
});

module.exports = router;
