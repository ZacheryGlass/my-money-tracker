const express = require('express');
const pool = require('../config/database');
const authenticateToken = require('../middleware/auth');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// GET /api/accounts - List all accounts
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, type FROM accounts ORDER BY type DESC, name ASC'
    );
    res.status(200).json({ accounts: result.rows });
  } catch (error) {
    console.error('Get accounts error:', error);
    res.status(500).json({ error: 'Server error retrieving accounts' });
  }
});

module.exports = router;
