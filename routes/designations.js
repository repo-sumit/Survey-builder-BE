const express = require('express');
const { pool } = require('../data/db');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

// ── Seed hierarchy level 99 for a state (idempotent) ──────────────────────────
async function seedLevel99(stateCode) {
  if (!stateCode) return;
  await pool.query(
    `INSERT INTO designation_hierarchy
       (state_code, designation_id, hierarchy_level, designation_name,
        medium, medium_in_english, is_active, created_by)
     VALUES ($1, 99, 99, 'Test', 'English', 'English', true, 'system')
     ON CONFLICT (state_code, designation_id) DO NOTHING`,
    [stateCode]
  );
}

// ── GET /api/designations ──────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    // Seed level 99 silently on every fetch
    const userState = req.user.role === 'admin'
      ? (req.query.stateCode || null)
      : req.user.stateCode;
    if (userState) await seedLevel99(userState);

    const conditions = [];
    const values = [];
    let i = 1;

    if (req.user.role !== 'admin') {
      // State users only see their own state
      conditions.push(`state_code = $${i++}`);
      values.push(req.user.stateCode);
    } else if (req.query.stateCode) {
      conditions.push(`state_code = $${i++}`);
      values.push(req.query.stateCode);
    }

    if (req.query.activeOnly === 'true') {
      conditions.push('is_active = true');
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM designation_hierarchy ${where} ORDER BY state_code, hierarchy_level, designation_id`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List designations error:', err);
    res.status(500).json({ error: 'Failed to fetch designations', message: err.message });
  }
});

// ── POST /api/designations/seed-defaults ──────────────────────────────────────
// Must be defined BEFORE /:designation_id to avoid route clash
router.post('/seed-defaults', requireAuth, async (req, res) => {
  try {
    const stateCode = req.user.role === 'admin'
      ? (req.body.stateCode || req.query.stateCode)
      : req.user.stateCode;
    if (!stateCode) return res.status(400).json({ error: 'State code required' });

    await seedLevel99(stateCode);
    res.json({ message: 'Defaults seeded', stateCode });
  } catch (err) {
    res.status(500).json({ error: 'Failed to seed defaults', message: err.message });
  }
});

// ── POST /api/designations ─────────────────────────────────────────────────────
router.post('/', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const {
      designation_id, hierarchy_level, designation_name,
      medium, medium_in_english, is_active, stateCode
    } = req.body;

    const resolvedState = req.user.role === 'admin' ? stateCode : req.user.stateCode;
    if (!resolvedState) return res.status(400).json({ error: 'State code is required' });

    const did = parseInt(designation_id, 10);
    if (!did || did < 1 || did > 100)
      return res.status(400).json({ error: 'designation_id must be between 1 and 100' });

    const hl = parseInt(hierarchy_level, 10);
    if (!hl && hl !== 0)
      return res.status(400).json({ error: 'hierarchy_level must be a number' });

    if (!designation_name || !medium || !medium_in_english)
      return res.status(400).json({
        error: 'designation_name, medium, and medium_in_english are required'
      });

    const result = await pool.query(
      `INSERT INTO designation_hierarchy
         (state_code, designation_id, hierarchy_level, designation_name,
          medium, medium_in_english, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [resolvedState, did, hl, designation_name, medium, medium_in_english,
        is_active !== undefined ? is_active : true, req.user.username]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({ error: 'A designation with this ID already exists for this state' });
    console.error('Create designation error:', err);
    res.status(500).json({ error: 'Failed to create designation', message: err.message });
  }
});

// ── PATCH /api/designations/:designation_id ───────────────────────────────────
router.patch('/:designation_id', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const did = parseInt(req.params.designation_id, 10);
    const stateCode = req.user.role === 'admin'
      ? (req.body.stateCode || req.query.stateCode)
      : req.user.stateCode;

    if (!stateCode) return res.status(400).json({ error: 'State code is required' });

    const existing = await pool.query(
      'SELECT * FROM designation_hierarchy WHERE state_code=$1 AND designation_id=$2',
      [stateCode, did]
    );
    if (existing.rows.length === 0)
      return res.status(404).json({ error: 'Designation not found' });

    const { designation_name, hierarchy_level, medium, medium_in_english, is_active } = req.body;
    const setClauses = [];
    const values = [];
    let i = 1;

    if (designation_name  !== undefined) { setClauses.push(`designation_name=$${i++}`);   values.push(designation_name); }
    if (hierarchy_level   !== undefined) { setClauses.push(`hierarchy_level=$${i++}`);    values.push(parseInt(hierarchy_level, 10)); }
    if (medium            !== undefined) { setClauses.push(`medium=$${i++}`);             values.push(medium); }
    if (medium_in_english !== undefined) { setClauses.push(`medium_in_english=$${i++}`);  values.push(medium_in_english); }
    if (is_active         !== undefined) { setClauses.push(`is_active=$${i++}`);          values.push(is_active); }

    if (setClauses.length === 0)
      return res.status(400).json({ error: 'No fields to update' });

    setClauses.push(`updated_by=$${i++}`);
    values.push(req.user.username);
    setClauses.push('updated_at=NOW()');
    values.push(stateCode, did);

    const result = await pool.query(
      `UPDATE designation_hierarchy
          SET ${setClauses.join(', ')}
        WHERE state_code=$${i} AND designation_id=$${i + 1}
        RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update designation error:', err);
    res.status(500).json({ error: 'Failed to update designation', message: err.message });
  }
});

module.exports = { router, seedLevel99 };
