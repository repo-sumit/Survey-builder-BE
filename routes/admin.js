const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../data/db');
const { requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

// GET /api/admin/users - List all users
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, state_code, is_active, created_at, updated_at FROM users ORDER BY created_at'
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      username: r.username,
      role: r.role,
      stateCode: r.state_code,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })));
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users', message: err.message });
  }
});

// POST /api/admin/users - Create user
router.post('/users', requireWriteAccess, async (req, res) => {
  try {
    const { username, password, role, stateCode } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (!['admin', 'state'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "state"' });
    }

    if (role === 'state' && !stateCode) {
      return res.status(400).json({ error: 'State code is required for state users' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
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

// PATCH /api/admin/users/:id - Update user (toggle active, reset password, change stateCode)
router.patch('/users/:id', requireWriteAccess, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { password, isActive, stateCode, role } = req.body;

    const existing = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [userId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = [];
    const values = [];
    let paramIdx = 1;

    if (password !== undefined) {
      const hash = await bcrypt.hash(password, 10);
      updates.push(`password = $${paramIdx++}`);
      values.push(hash);
    }

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIdx++}`);
      values.push(isActive);
    }

    if (stateCode !== undefined) {
      updates.push(`state_code = $${paramIdx++}`);
      values.push(stateCode || null);
    }

    if (role !== undefined) {
      if (!['admin', 'state'].includes(role)) {
        return res.status(400).json({ error: 'Role must be "admin" or "state"' });
      }
      updates.push(`role = $${paramIdx++}`);
      values.push(role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx}
       RETURNING id, username, role, state_code, is_active, updated_at`,
      values
    );

    const user = result.rows[0];
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      stateCode: user.state_code,
      isActive: user.is_active,
      updatedAt: user.updated_at
    });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user', message: err.message });
  }
});

module.exports = router;
