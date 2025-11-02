function validateHolding(req, res, next) {
  const { account_id, name } = req.body;

  // Required fields
  if (!account_id || !name) {
    return res.status(400).json({
      error: 'Missing required fields: account_id, name'
    });
  }

  // Validate types
  if (typeof account_id !== 'number' || typeof name !== 'string') {
    return res.status(400).json({
      error: 'Invalid field types'
    });
  }

  // Trim strings
  req.body.name = name.trim();
  req.body.ticker = req.body.ticker ? req.body.ticker.trim().toUpperCase() : null;
  req.body.category = req.body.category ? req.body.category.trim() : null;
  req.body.notes = req.body.notes ? req.body.notes.trim() : null;

  next();
}

module.exports = { validateHolding };
