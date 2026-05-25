const express = require('express');
// LEGACY LOGIN — disabled. Kept commented for reference.
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');
// const { pool } = require('../data/db');
// const { JWT_SECRET } = require('../middleware/auth');
// const { logAudit } = require('../services/audit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login — DISABLED. Use Google Sign-In via Supabase instead.
router.post('/login', (req, res) => {
  return res.status(410).json({
    error: 'Legacy login disabled',
    message: 'Username/password login has been removed. Sign in with Google.'
  });
});

/* LEGACY LOGIN — full implementation preserved here, commented out.
function legacyLoginEnabled() {
  return (process.env.LEGACY_LOGIN_ENABLED || 'true').toLowerCase() !== 'false';
}

router.post('/login', async (req, res) => {
  if (!legacyLoginEnabled()) {
    return res.status(410).json({
      error: 'Legacy login disabled',
      message: 'Username/password login is no longer available. Sign in with Google.'
    });
  }
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT id, username, email, name, password, role, state_code, is_active FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    if (!user.password) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      stateCode: user.state_code,
      isActive: user.is_active
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });

    logAudit({ user: { id: user.id, label: user.email || user.username, role: user.role, stateCode: user.state_code }, headers: req.headers, socket: req.socket }, {
      action: 'auth.login.legacy',
      entityType: 'user',
      entityId: String(user.id)
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        role: user.role,
        stateCode: user.state_code,
        isActive: user.is_active
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed', message: err.message });
  }
});
end LEGACY LOGIN */

// GET /api/auth/me — returns the local profile for the bearer token.
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
