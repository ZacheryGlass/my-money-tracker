const express = require('express');
const Holding = require('../models/Holding');
const authenticateToken = require('../middleware/auth');
const { validateHolding } = require('../middleware/validator');

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// GET /api/holdings - List all holdings
router.get('/', async (req, res) => {
  try {
    const holdings = await Holding.findAll();
    res.status(200).json({ holdings });
  } catch (error) {
    console.error('Get holdings error:', error);
    res.status(500).json({ error: 'Server error retrieving holdings' });
  }
});

// GET /api/holdings/:id - Get single holding
router.get('/:id', async (req, res) => {
  try {
    const holding = await Holding.findById(parseInt(req.params.id));
    if (!holding) {
      return res.status(404).json({ error: 'Holding not found' });
    }
    res.status(200).json({ holding });
  } catch (error) {
    console.error('Get holding error:', error);
    res.status(500).json({ error: 'Server error retrieving holding' });
  }
});

// POST /api/holdings - Create new holding
router.post('/', validateHolding, async (req, res) => {
  try {
    const { account_id, ticker, name, quantity, manual_value, category, notes } = req.body;

    const holding = await Holding.create(
      account_id,
      ticker,
      name,
      quantity || null,
      manual_value || null,
      category || null,
      notes || null
    );

    res.status(201).json({ holding });
  } catch (error) {
    console.error('Create holding error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This holding already exists for this account' });
    }
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Referenced account does not exist' });
    }
    res.status(500).json({ error: 'Server error creating holding' });
  }
});

// PUT /api/holdings/:id - Update holding
router.put('/:id', validateHolding, async (req, res) => {
  try {
    const { account_id, ticker, name, quantity, manual_value, category, notes } = req.body;
    const id = parseInt(req.params.id);

    // Check if holding exists
    const existing = await Holding.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    const holding = await Holding.update(
      id,
      account_id,
      ticker,
      name,
      quantity || null,
      manual_value || null,
      category || null,
      notes || null
    );

    res.status(200).json({ holding });
  } catch (error) {
    console.error('Update holding error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This holding already exists for this account' });
    }
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Referenced account does not exist' });
    }
    res.status(500).json({ error: 'Server error updating holding' });
  }
});

// DELETE /api/holdings/:id - Delete holding
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Check if holding exists
    const existing = await Holding.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    const result = await Holding.delete(id);
    res.status(200).json({ message: 'Holding deleted successfully', holding: result });
  } catch (error) {
    console.error('Delete holding error:', error);
    res.status(500).json({ error: 'Server error deleting holding' });
  }
});

module.exports = router;
