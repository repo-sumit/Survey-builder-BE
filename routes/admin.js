const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../data/db');
const { requireWriteAccess } = require('../middleware/auth');
const {
  listUsers,
  findUserById,
  findUserByEmail,
  insertUserInvite,
  updateUserProfile,
  attachEmailToUser
} = require('../data/store');
const { logAudit } = require('../services/audit');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/admin/users - List all users
router.get('/users', async (req, res) => {
  try {
    const users = await listUsers();
    res.json(users.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      name: u.name,
      role: u.role,
      stateCode: u.stateCode,
      isActive: u.isActive,
      supabaseUserId: u.supabaseUserId,
      authSource: u.email ? (u.username ? 'both' : 'google') : (u.username ? 'legacy' : 'none'),
      invitedAt: u.invitedAt,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt
    })));
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users', message: err.message });
  }
});

// POST /api/admin/users
// Two shapes accepted (dual-auth window):
//   1) Invite by email (preferred):  { email, name, role, stateCode }
//   2) Legacy create:                { username, password, role, stateCode }
router.post('/users', requireWriteAccess, async (req, res) => {
  try {
    const { email, name, username, password, role, stateCode } = req.body;

    if (!['admin', 'state'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "state"' });
    }
    if (role === 'state' && !stateCode) {
      return res.status(400).json({ error: 'State code is required for state users' });
    }

    // Invite path
    if (email) {
      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      const existing = await findUserByEmail(email);
      if (existing) {
        return res.status(409).json({ error: 'A user with that email already exists' });
      }
      const profile = await insertUserInvite({
        email: email.toLowerCase(),
        name,
        role,
        stateCode: role === 'admin' ? null : stateCode
      });
      logAudit(req, {
        action: 'user.invite',
        entityType: 'user',
        entityId: String(profile.id),
        metadata: { email: profile.email, role: profile.role, stateCode: profile.stateCode }
      });
      return res.status(201).json(profile);
    }

    // Legacy create path (kept for dual-auth window)
    if (!username || !password) {
      return res.status(400).json({ error: 'Provide email + name (invite) or username + password (legacy)' });
    }
    const existingLegacy = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingLegacy.rows.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password, role, state_code, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, username, role, state_code, is_active, created_at`,
      [username, hash, role, role === 'admin' ? null : stateCode]
    );
    const user = result.rows[0];
    logAudit(req, {
      action: 'user.create.legacy',
      entityType: 'user',
      entityId: String(user.id),
      metadata: { username: user.username, role: user.role, stateCode: user.state_code }
    });
    res.status(201).json({
      id: user.id,
      username: user.username,
      role: user.role,
      stateCode: user.state_code,
      isActive: user.is_active,
      createdAt: user.created_at
    });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user', message: err.message });
  }
});

// PATCH /api/admin/users/:id
// Accepts: { name, role, stateCode, isActive, password }
// `password` is only used to reset legacy users' passwords. It is rejected for invite-only users.
router.patch('/users/:id', requireWriteAccess, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { password, isActive, stateCode, role, name } = req.body;

    const existing = await findUserById(userId);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (role !== undefined && !['admin', 'state'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "state"' });
    }

    // Update profile fields via the helper.
    const profileUpdates = {};
    if (name !== undefined)      profileUpdates.name = name;
    if (role !== undefined)      profileUpdates.role = role;
    if (stateCode !== undefined) profileUpdates.stateCode = (role === 'admin' || existing.role === 'admin') ? null : stateCode;
    if (isActive !== undefined)  profileUpdates.isActive = isActive;

    let updated = existing;
    if (Object.keys(profileUpdates).length > 0) {
      updated = await updateUserProfile(userId, profileUpdates);
    }

    // Optional legacy password reset (only meaningful while username is set)
    if (password !== undefined) {
      if (!existing.username) {
        return res.status(400).json({ error: 'Cannot set password on an invite-only user' });
      }
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hash, userId]);
    }

    logAudit(req, {
      action: 'user.update',
      entityType: 'user',
      entityId: String(userId),
      metadata: {
        changed: Object.keys(profileUpdates),
        passwordReset: password !== undefined
      }
    });

    res.json(updated);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user', message: err.message });
  }
});

// POST /api/admin/users/:id/attach-email
// Backfill an email + name on a legacy user so they can switch to Google sign-in.
router.post('/users/:id/attach-email', requireWriteAccess, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { email, name } = req.body;
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    const existing = await findUserById(userId);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (existing.email) {
      return res.status(409).json({ error: 'User already has an email' });
    }
    const conflict = await findUserByEmail(email);
    if (conflict) {
      return res.status(409).json({ error: 'Another user already has that email' });
    }
    const updated = await attachEmailToUser(userId, { email: email.toLowerCase(), name });
    logAudit(req, {
      action: 'user.attach_email',
      entityType: 'user',
      entityId: String(userId),
      metadata: { email: updated.email }
    });
    res.json(updated);
  } catch (err) {
    console.error('Attach email error:', err);
    res.status(500).json({ error: 'Failed to attach email', message: err.message });
  }
});

// ── State Config CRUD ────────────────────────────────────────────────────────

// GET /api/admin/state-config
router.get('/state-config', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT state_code, state_name, available_languages FROM state_config ORDER BY state_name'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List state config error:', err);
    res.status(500).json({ error: 'Failed to list state configs', message: err.message });
  }
});

// POST /api/admin/state-config
router.post('/state-config', requireWriteAccess, async (req, res) => {
  try {
    const { state_code, state_name, available_languages } = req.body;
    if (!state_code || !state_name)
      return res.status(400).json({ error: 'state_code and state_name are required' });

    const result = await pool.query(
      `INSERT INTO state_config (state_code, state_name, available_languages)
       VALUES ($1, $2, $3)
       ON CONFLICT (state_code) DO UPDATE
         SET state_name = EXCLUDED.state_name,
             available_languages = EXCLUDED.available_languages
       RETURNING *`,
      [state_code.trim(), state_name.trim(), (available_languages || '').trim()]
    );
    logAudit(req, {
      action: 'state_config.upsert',
      entityType: 'state_config',
      entityId: state_code.trim(),
      metadata: { state_name }
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create state config error:', err);
    res.status(500).json({ error: 'Failed to create state config', message: err.message });
  }
});

// PATCH /api/admin/state-config/:state_code
router.patch('/state-config/:state_code', requireWriteAccess, async (req, res) => {
  try {
    const { state_code } = req.params;
    const { state_name, available_languages } = req.body;

    const existing = await pool.query('SELECT * FROM state_config WHERE state_code=$1', [state_code]);
    if (existing.rows.length === 0)
      return res.status(404).json({ error: 'State config not found' });

    const setClauses = [];
    const values = [];
    let i = 1;

    if (state_name !== undefined) { setClauses.push(`state_name=$${i++}`); values.push(state_name.trim()); }
    if (available_languages !== undefined) { setClauses.push(`available_languages=$${i++}`); values.push(available_languages.trim()); }

    if (setClauses.length === 0)
      return res.status(400).json({ error: 'No fields to update' });

    values.push(state_code);
    const result = await pool.query(
      `UPDATE state_config SET ${setClauses.join(', ')} WHERE state_code=$${i} RETURNING *`,
      values
    );
    logAudit(req, {
      action: 'state_config.update',
      entityType: 'state_config',
      entityId: state_code
    });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update state config error:', err);
    res.status(500).json({ error: 'Failed to update state config', message: err.message });
  }
});

// DELETE /api/admin/state-config/:state_code
router.delete('/state-config/:state_code', requireWriteAccess, async (req, res) => {
  try {
    const { state_code } = req.params;
    const result = await pool.query(
      'DELETE FROM state_config WHERE state_code=$1 RETURNING state_code',
      [state_code]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'State config not found' });
    logAudit(req, {
      action: 'state_config.delete',
      entityType: 'state_config',
      entityId: state_code
    });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete state config error:', err);
    res.status(500).json({ error: 'Failed to delete state config', message: err.message });
  }
});

module.exports = router;
