function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // Handle specific database errors
  if (err.code === '23505') {
    // Unique constraint violation
    return res.status(409).json({
      error: 'This holding already exists for this account'
    });
  }

  if (err.code === '23503') {
    // Foreign key violation
    return res.status(400).json({
      error: 'Referenced account does not exist'
    });
  }

  // Default error response
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
}

module.exports = errorHandler;
