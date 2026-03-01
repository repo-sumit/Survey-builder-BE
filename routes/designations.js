const express = require('express');
const ExcelJS = require('exceljs');
const { pool } = require('../data/db');
const { requireAuth, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

// ── Seed hierarchy level 99 for a state (idempotent) ──────────────────────────
async function seedLevel99(stateCode) {
  if (!stateCode) return;
  await pool.query(
    `INSERT INTO designation_hierarchy
       (state_code, hierarchy_level, designation_name, medium, medium_in_english, is_active, created_by)
     VALUES ($1, 99, 'Test', 'English', 'English', true, 'system')
     ON CONFLICT (state_code, medium_in_english, hierarchy_level) DO NOTHING`,
    [stateCode]
  );
}

// ── GET /api/designations ──────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const userState = req.user.role === 'admin'
      ? (req.query.stateCode || null)
      : req.user.stateCode;

    // Seed level 99 silently on every fetch for state users
    if (userState && req.user.role !== 'admin') await seedLevel99(userState);

    const conditions = [];
    const values = [];
    let i = 1;

    if (req.user.role !== 'admin') {
      conditions.push(`state_code = $${i++}`);
      values.push(req.user.stateCode);
    } else if (req.query.stateCode) {
      conditions.push(`state_code = $${i++}`);
      values.push(req.query.stateCode);
    }

    // Optional medium filter
    if (req.query.medium) {
      conditions.push(`medium_in_english = $${i++}`);
      values.push(req.query.medium);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, state_code, hierarchy_level, designation_name, medium, medium_in_english, created_by, updated_by, created_at, updated_at
         FROM designation_hierarchy ${where}
        ORDER BY state_code, medium_in_english, hierarchy_level`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List designations error:', err);
    res.status(500).json({ error: 'Failed to fetch designations', message: err.message });
  }
});

// ── GET /api/designations/export ───────────────────────────────────────────────
// Download designation mapping as XLSX (matches test.xlsx format)
router.get('/export', requireAuth, async (req, res) => {
  try {
    const stateCode = req.user.role === 'admin'
      ? (req.query.stateCode || null)
      : req.user.stateCode;

    const conditions = stateCode ? [`state_code = $1`] : [];
    const values = stateCode ? [stateCode] : [];

    const result = await pool.query(
      `SELECT state_code, medium, medium_in_english, designation_name, hierarchy_level
         FROM designation_hierarchy
         ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
        ORDER BY state_code, medium_in_english, hierarchy_level`,
      values
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'FMB Survey Builder';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Designation Mapping');
    sheet.columns = [
      { header: 'State',               key: 'state',              width: 25 },
      { header: 'Medium',              key: 'medium',             width: 18 },
      { header: 'Medium_in_english',   key: 'medium_in_english',  width: 18 },
      { header: 'List of Designations',key: 'designation_name',   width: 35 },
      { header: 'Hierarchical Level',  key: 'hierarchy_level',    width: 18 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FF1F3864' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    headerRow.alignment = { horizontal: 'center' };
    headerRow.border = { bottom: { style: 'medium', color: { argb: 'FF1F3864' } } };

    result.rows.forEach(r => {
      sheet.addRow({
        state: r.state_code,
        medium: r.medium,
        medium_in_english: r.medium_in_english,
        designation_name: r.designation_name,
        hierarchy_level: r.hierarchy_level,
      });
    });

    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = stateCode
      ? `designation_mapping_${stateCode}.xlsx`
      : 'designation_mapping_all.xlsx';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Export designations error:', err);
    res.status(500).json({ error: 'Failed to export designations', message: err.message });
  }
});

// ── POST /api/designations/seed-defaults ──────────────────────────────────────
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
    const { hierarchy_level, designation_name, medium, medium_in_english, stateCode } = req.body;

    const resolvedState = req.user.role === 'admin' ? stateCode : req.user.stateCode;
    if (!resolvedState) return res.status(400).json({ error: 'State code is required' });

    const hl = parseInt(hierarchy_level, 10);
    if (!hl || hl < 1)
      return res.status(400).json({ error: 'hierarchy_level must be a positive number' });

    if (!designation_name || !medium || !medium_in_english)
      return res.status(400).json({
        error: 'designation_name, medium, and medium_in_english are required'
      });

    const result = await pool.query(
      `INSERT INTO designation_hierarchy
         (state_code, hierarchy_level, designation_name, medium, medium_in_english, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6)
       RETURNING id, state_code, hierarchy_level, designation_name, medium, medium_in_english`,
      [resolvedState, hl, designation_name.trim(), medium.trim(), medium_in_english.trim(),
        req.user.username]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({
        error: 'A designation with this hierarchy level already exists for this state and medium'
      });
    console.error('Create designation error:', err);
    res.status(500).json({ error: 'Failed to create designation', message: err.message });
  }
});

// ── PATCH /api/designations/:id ───────────────────────────────────────────────
// Uses the serial PK `id` to identify the row
router.patch('/:id', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const rowId = parseInt(req.params.id, 10);
    if (!rowId) return res.status(400).json({ error: 'Invalid id' });

    const stateCode = req.user.role === 'admin'
      ? (req.body.stateCode || req.query.stateCode)
      : req.user.stateCode;
    if (!stateCode) return res.status(400).json({ error: 'State code is required' });

    const existing = await pool.query(
      'SELECT * FROM designation_hierarchy WHERE id=$1 AND state_code=$2',
      [rowId, stateCode]
    );
    if (existing.rows.length === 0)
      return res.status(404).json({ error: 'Designation not found' });

    const { designation_name, hierarchy_level, medium, medium_in_english } = req.body;
    const setClauses = [];
    const values = [];
    let i = 1;

    if (designation_name  !== undefined) { setClauses.push(`designation_name=$${i++}`);   values.push(designation_name.trim()); }
    if (hierarchy_level   !== undefined) { setClauses.push(`hierarchy_level=$${i++}`);    values.push(parseInt(hierarchy_level, 10)); }
    if (medium            !== undefined) { setClauses.push(`medium=$${i++}`);             values.push(medium.trim()); }
    if (medium_in_english !== undefined) { setClauses.push(`medium_in_english=$${i++}`);  values.push(medium_in_english.trim()); }

    if (setClauses.length === 0)
      return res.status(400).json({ error: 'No fields to update' });

    setClauses.push(`updated_by=$${i++}`);
    values.push(req.user.username);
    setClauses.push('updated_at=NOW()');
    values.push(rowId, stateCode);

    const result = await pool.query(
      `UPDATE designation_hierarchy
          SET ${setClauses.join(', ')}
        WHERE id=$${i} AND state_code=$${i + 1}
        RETURNING id, state_code, hierarchy_level, designation_name, medium, medium_in_english`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({
        error: 'A designation with this hierarchy level already exists for this state and medium'
      });
    console.error('Update designation error:', err);
    res.status(500).json({ error: 'Failed to update designation', message: err.message });
  }
});

// ── DELETE /api/designations/:id ──────────────────────────────────────────────
router.delete('/:id', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const rowId = parseInt(req.params.id, 10);
    if (!rowId) return res.status(400).json({ error: 'Invalid id' });

    const stateCode = req.user.role === 'admin'
      ? (req.body.stateCode || req.query.stateCode)
      : req.user.stateCode;
    if (!stateCode) return res.status(400).json({ error: 'State code is required' });

    const result = await pool.query(
      'DELETE FROM designation_hierarchy WHERE id=$1 AND state_code=$2 RETURNING id',
      [rowId, stateCode]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Designation not found' });

    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete designation error:', err);
    res.status(500).json({ error: 'Failed to delete designation', message: err.message });
  }
});

module.exports = { router, seedLevel99 };
