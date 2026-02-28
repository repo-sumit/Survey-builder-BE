const express = require('express');
const { pool } = require('../data/db');
const { requireAuth } = require('../middleware/auth');
const {
  validateAccessSheet,
  generateAccessSheetXlsx,
  parseAccessSheetXlsx
} = require('../services/accessSheetUtils');

const router = express.Router();

// ── Helper: resolve state for the request ─────────────────────────────────────
function resolveState(req, source = {}) {
  if (req.user.role === 'admin') return source.stateCode || req.user.stateCode || null;
  return req.user.stateCode;
}

// ── POST /api/access-sheet/dump ───────────────────────────────────────────────
// Generate a fresh XLSX from current designations, validate, then UPSERT.
router.post('/dump', requireAuth, async (req, res) => {
  try {
    const stateCode = resolveState(req, req.body);
    if (!stateCode) return res.status(400).json({ error: 'State code is required' });

    // Fetch active designations for this state
    const desgResult = await pool.query(
      `SELECT * FROM designation_hierarchy
        WHERE state_code=$1 AND is_active=true
        ORDER BY hierarchy_level, designation_id`,
      [stateCode]
    );
    const designations = desgResult.rows;

    // Generate XLSX
    const fileBytes = await generateAccessSheetXlsx(stateCode, designations);
    const dateTag  = new Date().toISOString().split('T')[0];
    const fileName = `access_sheet_${stateCode}_${dateTag}.xlsx`;

    // Validate the generated file against DB (should always pass since data comes from DB)
    const parsedRows = await parseAccessSheetXlsx(fileBytes);
    const validation = await validateAccessSheet(parsedRows, stateCode);
    if (!validation.valid) {
      return res.status(422).json({
        errorCode: 'ACCESS_SHEET_VALIDATION_FAILED',
        issues: validation.issues
      });
    }

    const summary = {
      designationCount: designations.length,
      generatedAt: new Date().toISOString(),
      rowCount: parsedRows.length
    };

    // UPSERT — overwrite previous dump for this state
    await pool.query(
      `INSERT INTO access_sheet_latest_dump
         (state_code, dumped_at, dumped_by, file_name, mime_type, file_bytes, summary)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6)
       ON CONFLICT (state_code) DO UPDATE SET
         dumped_at  = NOW(),
         dumped_by  = $2,
         file_name  = $3,
         file_bytes = $5,
         summary    = $6`,
      [
        stateCode,
        req.user.username,
        fileName,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileBytes,
        JSON.stringify(summary)
      ]
    );

    res.json({
      success: true,
      stateCode,
      fileName,
      dumpedAt: new Date().toISOString(),
      summary
    });
  } catch (err) {
    console.error('Access sheet dump error:', err);
    res.status(500).json({ error: 'Failed to dump access sheet', message: err.message });
  }
});

// ── GET /api/access-sheet/latest ─────────────────────────────────────────────
// Returns metadata only (no file bytes)
router.get('/latest', requireAuth, async (req, res) => {
  try {
    const stateCode = resolveState(req, req.query);
    if (!stateCode) return res.status(400).json({ error: 'State code required' });

    const result = await pool.query(
      `SELECT state_code, dumped_at, dumped_by, file_name, summary
         FROM access_sheet_latest_dump WHERE state_code=$1`,
      [stateCode]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ errorCode: 'NO_DUMP', message: 'No dump exists for this state' });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch latest dump', message: err.message });
  }
});

// ── GET /api/access-sheet/latest/download ─────────────────────────────────────
router.get('/latest/download', requireAuth, async (req, res) => {
  try {
    const stateCode = resolveState(req, req.query);
    if (!stateCode) return res.status(400).json({ error: 'State code required' });

    const result = await pool.query(
      `SELECT file_name, mime_type, file_bytes
         FROM access_sheet_latest_dump WHERE state_code=$1`,
      [stateCode]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ errorCode: 'NO_DUMP', message: 'No dump exists for this state' });

    const { file_name, mime_type, file_bytes } = result.rows[0];
    res.setHeader('Content-Type', mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file_name}"`);
    res.send(file_bytes);
  } catch (err) {
    res.status(500).json({ error: 'Failed to download', message: err.message });
  }
});

// ── POST /api/access-sheet/validate (skeleton for future upload-validate) ─────
router.post('/validate', requireAuth, async (req, res) => {
  res.status(501).json({ message: 'Upload-validate not yet implemented. Use /dump instead.' });
});

module.exports = router;
