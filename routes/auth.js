const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../data/db');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/audit');

const router = express.Router();

function legacyLoginEnabled() {
  return (process.env.LEGACY_LOGIN_ENABLED || 'true').toLowerCase() !== 'false';
}

// POST /api/auth/login  (legacy username/password — gated by LEGACY_LOGIN_ENABLED)
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
      // User exists but has no password (invite-only Google account).
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

    // Fire-and-forget audit (best-effort: req.user isn't set on the public route)
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

// GET /api/auth/me — returns the local profile for the bearer token.
// Works for both auth paths (Supabase JWT and legacy JWT).
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
