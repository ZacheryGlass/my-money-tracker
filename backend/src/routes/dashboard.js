const express = require('express');
const DashboardService = require('../services/DashboardService');
const authenticateToken = require('../middleware/auth');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// GET /api/dashboard - Get portfolio summary
router.get('/', async (req, res) => {
  try {
    const portfolio = await DashboardService.getCurrentPortfolio();
    res.status(200).json(portfolio);
  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({ error: 'Server error retrieving dashboard' });
  }
});

module.exports = router;
