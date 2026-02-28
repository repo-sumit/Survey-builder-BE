const ExcelJS = require('exceljs');
const { pool } = require('../data/db');

// ── Parse an uploaded XLSX buffer → array of row objects ──────────────────────
async function parseAccessSheetXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];

  const rows = [];
  let headers = null;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) {
      headers = row.values.slice(1).map(h => String(h ?? '').trim());
      return;
    }
    const obj = { rowNumber };
    row.values.slice(1).forEach((val, idx) => {
      if (headers[idx] !== undefined) {
        obj[headers[idx]] = val !== null && val !== undefined ? String(val).trim() : '';
      }
    });
    rows.push(obj);
  });

  return rows;
}

// ── Validate access sheet rows against DB ─────────────────────────────────────
// Returns { valid: boolean, issues: [{row, column, message}] }
async function validateAccessSheet(rows, stateCode) {
  const issues = [];

  // Fetch valid hierarchy levels for this state
  const hlResult = await pool.query(
    'SELECT DISTINCT hierarchy_level FROM designation_hierarchy WHERE state_code=$1 AND is_active=true',
    [stateCode]
  );
  const validLevels = new Set(hlResult.rows.map(r => String(r.hierarchy_level)));

  const seenUserIds = new Map();

  for (const row of rows) {
    // State consistency
    const rowState = (row['State'] || '').trim();
    if (rowState && rowState !== stateCode) {
      issues.push({
        row: row.rowNumber,
        column: 'State',
        message: `State must be "${stateCode}", found "${rowState}"`
      });
    }

    // Hierarchy level must exist in designation_hierarchy
    const hl = (row['Hierarchical Level'] || '').trim();
    if (hl && !validLevels.has(hl)) {
      issues.push({
        row: row.rowNumber,
        column: 'Hierarchical Level',
        message: `Level "${hl}" does not exist in Designation Mapping for state "${stateCode}"`
      });
    }

    // User ID uniqueness
    const uid = (row['User ID'] || '').trim();
    if (uid) {
      if (seenUserIds.has(uid)) {
        issues.push({
          row: row.rowNumber,
          column: 'User ID',
          message: `Duplicate User ID "${uid}" (first seen at row ${seenUserIds.get(uid)})`
        });
      } else {
        seenUserIds.set(uid, row.rowNumber);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// ── Generate an XLSX access sheet in-memory ───────────────────────────────────
// Returns a Buffer containing the .xlsx bytes
async function generateAccessSheetXlsx(stateCode, designations) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FMB Survey Builder';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Access Sheet');

  // Columns
  sheet.columns = [
    { header: 'Designation',        key: 'designation',       width: 28 },
    { header: 'Hierarchical Level', key: 'hierarchicalLevel', width: 20 },
    { header: 'State',              key: 'state',             width: 12 },
    { header: 'Name',               key: 'name',              width: 22 },
    { header: 'User ID',            key: 'userId',            width: 20 },
    { header: 'Status',             key: 'status',            width: 14 },
  ];

  // Style header
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1F3864' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  headerRow.alignment = { horizontal: 'center' };
  headerRow.border = {
    bottom: { style: 'medium', color: { argb: 'FF1F3864' } }
  };

  // One template row per active designation
  designations.forEach(d => {
    const dataRow = sheet.addRow({
      designation:       d.designation_name,
      hierarchicalLevel: d.hierarchy_level,
      state:             stateCode,
      name:              '',
      userId:            '',
      status:            'Active',
    });
    dataRow.getCell('status').dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"Active,Inactive"'],
    };
  });

  // Freeze header
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { parseAccessSheetXlsx, validateAccessSheet, generateAccessSheetXlsx };
