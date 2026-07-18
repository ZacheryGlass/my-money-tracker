'use strict';

const express = require('express');
const DashboardService = require('../services/DashboardService');
const requireUser = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

// Apply auth middleware to all routes
router.use(requireUser);

// GET /api/dashboard - Get portfolio summary
router.get('/', async (req, res) => {
  try {
    const portfolio = await DashboardService.getCurrentPortfolio();
    res.status(200).json(portfolio);
  } catch (error) {
    logger.error({ err: error }, 'Get dashboard error');
    res.status(500).json({ error: 'Server error retrieving dashboard' });
  }
});

module.exports = router;
