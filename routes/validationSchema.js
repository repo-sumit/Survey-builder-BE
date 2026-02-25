const express = require('express');
const router = express.Router();
const validationEngine = require('../validation/validationEngine');

/**
 * GET /api/validation-schema
 * Returns the validation schema for frontend alignment
 */
router.get('/', (req, res) => {
  try {
    const schema = validationEngine.getValidationSchema();
    res.json(schema);
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get validation schema', 
      message: error.message 
    });
  }
});

module.exports = router;
