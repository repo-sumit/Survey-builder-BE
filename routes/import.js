const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const path = require('path');
const validator = require('../services/validator');
const { upsertSurvey, upsertQuestion, findExistingSurveyIds, deleteSurvey } = require('../data/store');
const { logAudit } = require('../services/audit');

const parsedMaxImportSizeMb = Number(process.env.IMPORT_MAX_FILE_SIZE_MB);
const MAX_IMPORT_FILE_SIZE_MB = Number.isFinite(parsedMaxImportSizeMb) && parsedMaxImportSizeMb > 0
  ? parsedMaxImportSizeMb
  : 10;
const MAX_IMPORT_FILE_SIZE_BYTES = Math.floor(MAX_IMPORT_FILE_SIZE_MB * 1024 * 1024);

const parsedMaxImportRows = Number(process.env.IMPORT_MAX_ROWS);
const MAX_IMPORT_ROWS = Number.isFinite(parsedMaxImportRows) && parsedMaxImportRows > 0
  ? Math.floor(parsedMaxImportRows)
  : 10000;

const parsedUpsertBatchSize = Number(process.env.IMPORT_UPSERT_BATCH_SIZE);
const UPSERT_BATCH_SIZE = Number.isFinite(parsedUpsertBatchSize) && parsedUpsertBatchSize > 0
  ? Math.floor(parsedUpsertBatchSize)
  : 25;

const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const fileExt = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_UPLOAD_EXTENSIONS.has(fileExt)) {
      return cb(null, true);
    }
    return cb(new Error('Unsupported file format. Please upload XLSX, XLS, or CSV.'));
  }
});

function importUploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'Upload file too large',
        message: `Maximum supported upload size is ${MAX_IMPORT_FILE_SIZE_MB} MB.`,
        details: {
          limitMb: MAX_IMPORT_FILE_SIZE_MB
        }
      });
    }

    return res.status(400).json({
      error: 'File upload failed',
      message: error.message || 'Unable to process uploaded file.'
    });
  });
}

// Find a worksheet by name with case-insensitive, trim-aware matching
function findWorksheet(workbook, name) {
  // Try exact match first
  const exact = workbook.getWorksheet(name);
  if (exact) return exact;
  // Fallback: case-insensitive + trimmed match
  const normalized = name.trim().toLowerCase();
  return workbook.worksheets.find(
    s => s.name.trim().toLowerCase() === normalized
  ) || null;
}

// Convert column number (1-based) to Excel letter (A, B, ..., Z, AA, AB, ...)
function colNumToLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Helper function to parse XLSX file
async function parseXLSX(fileBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);

  const result = {
    surveys: [],
    questions: [],
    diagnostics: {
      sheetNames: workbook.worksheets.map(s => s.name),
      surveySheet: { found: false, headers: [], rowCount: 0, skippedRows: 0, sheetName: null },
      questionSheet: { found: false, headers: [], rowCount: 0, skippedRows: 0, sheetName: null }
    }
  };

  // Parse Survey Master sheet (case-insensitive, trim-aware)
  const surveySheet = findWorksheet(workbook, 'Survey Master');
  if (surveySheet) {
    result.diagnostics.surveySheet.found = true;
    result.diagnostics.surveySheet.sheetName = surveySheet.name;
    const headers = [];
    const fieldToColLetter = {};
    surveySheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = normalizeCellValue(cell.value);
      const fieldName = mapSurveyColumnToField(headers[colNumber]);
      if (fieldName && !fieldToColLetter[fieldName]) {
        fieldToColLetter[fieldName] = colNumToLetter(colNumber);
      }
    });
    result.diagnostics.surveySheet.headers = headers.filter(Boolean);

    surveySheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      // Skip completely empty rows
      let hasData = false;
      const survey = {};
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber];
        if (header) {
          const fieldName = mapSurveyColumnToField(header);
          const value = normalizeCellValue(cell.value);
          if (value !== null && value !== undefined && value !== '') hasData = true;
          survey[fieldName] = value;
        }
      });

      if (hasData && survey.surveyId) {
        survey.mode = normalizeMode(survey.mode);
        survey._sourceRow = rowNumber;
        survey._sheet = surveySheet.name;
        survey._fieldToCol = fieldToColLetter;
        result.surveys.push(survey);
      } else if (hasData) {
        result.diagnostics.surveySheet.skippedRows += 1;
      }
    });
    result.diagnostics.surveySheet.rowCount = result.surveys.length;
  }

  // Parse Question Master sheet (case-insensitive, trim-aware)
  const questionSheet = findWorksheet(workbook, 'Question Master');
  if (questionSheet) {
    result.diagnostics.questionSheet.found = true;
    result.diagnostics.questionSheet.sheetName = questionSheet.name;
    const headers = [];
    const qFieldToColLetter = {};
    questionSheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = normalizeCellValue(cell.value);
      const fieldName = mapQuestionColumnToField(headers[colNumber]);
      if (fieldName && !qFieldToColLetter[fieldName]) {
        qFieldToColLetter[fieldName] = colNumToLetter(colNumber);
      }
    });
    result.diagnostics.questionSheet.headers = headers.filter(Boolean);

    const questionsByKey = {};

    questionSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const questionRow = {};
      let hasData = false;
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber];
        if (header) {
          const fieldName = mapQuestionColumnToField(header);
          const value = normalizeCellValue(cell.value);
          if (value !== null && value !== undefined && value !== '') hasData = true;
          questionRow[fieldName] = value;
        }
      });

      if (!hasData) return; // Skip empty rows

      if (!questionRow.surveyId || !questionRow.questionId) {
        result.diagnostics.questionSheet.skippedRows += 1;
        return;
      }

      {
        const key = `${questionRow.surveyId}_${questionRow.questionId}_${questionRow.questionType}`;

        if (!questionsByKey[key]) {
          questionsByKey[key] = {
            surveyId: questionRow.surveyId,
            questionId: questionRow.questionId,
            questionType: questionRow.questionType,
            isDynamic: questionRow.isDynamic,
            isMandatory: normalizeIsMandatory(questionRow.isMandatory),
            sourceQuestion: questionRow.sourceQuestion || '',
            textInputType: normalizeTextInputType(questionRow.textInputType) || 'None',
            textLimitCharacters: String(questionRow.textLimitCharacters || ''),
            maxValue: String(questionRow.maxValue || ''),
            minValue: String(questionRow.minValue || ''),
            tableHeaderValue: questionRow.tableHeaderValue || '',
            tableQuestionValue: normalizeTableQuestionValue(questionRow.tableQuestionValue),
            questionMediaLink: questionRow.questionMediaLink || '',
            questionMediaType: questionRow.questionMediaType || 'None',
            mode: normalizeMode(questionRow.mode),
            translations: {},
            _sourceRow: rowNumber,
            _sheet: questionSheet.name,
            _fieldToCol: qFieldToColLetter
          };
        }

        // Add translation for this language
        const language = questionRow.mediumInEnglish || questionRow.medium || 'English';
        questionsByKey[key].translations[language] = {
          questionDescription: questionRow.questionDescription || '',
          questionDescriptionOptional: questionRow.questionDescriptionOptional || '',
          tableHeaderValue: questionRow.tableHeaderValue || '',
          tableQuestionValue: normalizeTableQuestionValue(questionRow.tableQuestionValue),
          options: parseOptions(questionRow)
        };
      }
    });

    result.questions = Object.values(questionsByKey).map(applyPrimaryTranslation);
    result.diagnostics.questionSheet.rowCount = result.questions.length;
  }

  return result;
}

// Normalize common text input type typos
function normalizeTextInputType(value) {
  if (!value) return value;
  const normalized = String(value).trim();
  const map = {
    'numaric': 'Numeric',
    'numeric': 'Numeric',
    'alphanumeric': 'Alphanumeric',
    'alphabets': 'Alphabets',
    'text': 'Alphanumeric',
    'none': 'None'
  };
  return map[normalized.toLowerCase()] || normalized;
}

// Empty cells in the "Is Mandatory" column are treated as "No" so the column
// can be left blank in the import sheet.
function normalizeIsMandatory(value) {
  if (value === null || value === undefined) return 'No';
  const str = String(value).trim();
  return str === '' ? 'No' : str;
}

// Cells that come from sources where newlines were escaped (e.g. CSV exports)
// may contain the literal two-char sequence "\n" instead of a real line break.
// Treat that literal as a row separator so the format check passes.
function normalizeTableQuestionValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\\n/g, '\n');
}

// Mode column comes in many casings ("new data", "New data", "NEW DATA", etc.)
// — collapse to the canonical form so downstream filters/enums work.
function normalizeMode(value) {
  if (value === null || value === undefined) return 'None';
  const str = String(value).trim().toLowerCase();
  if (str === '' || str === 'none') return 'None';
  if (str === 'new data' || str === 'newdata') return 'New Data';
  if (str === 'correction') return 'Correction';
  if (str === 'delete data' || str === 'deletedata') return 'Delete Data';
  return String(value).trim();
}

// Helper function to parse CSV file
async function parseCSV(fileBuffer, sheetType) {
  const fileContent = fileBuffer.toString('utf8');
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  const inferredType = inferSheetType(records, sheetType);

  if (inferredType === 'survey') {
    return { surveys: records.map(mapSurveyRecord), questions: [] };
  } else if (inferredType === 'question') {
    // Group questions by key
    const questionsByKey = {};
    
    records.forEach(record => {
      const questionRow = mapQuestionRecord(record);
      if (questionRow.surveyId && questionRow.questionId) {
        const key = `${questionRow.surveyId}_${questionRow.questionId}_${questionRow.questionType}`;
        
        if (!questionsByKey[key]) {
          questionsByKey[key] = {
            surveyId: questionRow.surveyId,
            questionId: questionRow.questionId,
            questionType: questionRow.questionType,
            isDynamic: questionRow.isDynamic,
            isMandatory: normalizeIsMandatory(questionRow.isMandatory),
            sourceQuestion: questionRow.sourceQuestion || '',
            textInputType: questionRow.textInputType || 'None',
            textLimitCharacters: questionRow.textLimitCharacters || '',
            maxValue: questionRow.maxValue || '',
            minValue: questionRow.minValue || '',
            tableHeaderValue: questionRow.tableHeaderValue || '',
            tableQuestionValue: normalizeTableQuestionValue(questionRow.tableQuestionValue),
            questionMediaLink: questionRow.questionMediaLink || '',
            questionMediaType: questionRow.questionMediaType || 'None',
            mode: normalizeMode(questionRow.mode),
            translations: {}
          };
        }

        const language = questionRow.mediumInEnglish || questionRow.medium || 'English';
        questionsByKey[key].translations[language] = {
          questionDescription: questionRow.questionDescription || '',
          questionDescriptionOptional: questionRow.questionDescriptionOptional || '',
          tableHeaderValue: questionRow.tableHeaderValue || '',
          tableQuestionValue: normalizeTableQuestionValue(questionRow.tableQuestionValue),
          options: parseOptions(questionRow)
        };
      }
    });
    
    return { surveys: [], questions: Object.values(questionsByKey).map(applyPrimaryTranslation) };
  }
  
  return { surveys: [], questions: [] };
}

// Map Survey column names to field names
function mapSurveyColumnToField(columnName) {
  const normalized = normalizeHeaderKey(columnName);
  const mapping = {
    surveyid: 'surveyId',
    surveyname: 'surveyName',
    surveydescription: 'surveyDescription',
    availablemediums: 'availableMediums',
    hierarchicalaccesslevel: 'hierarchicalAccessLevel',
    public: 'public',
    inschool: 'inSchool',
    acceptmultipleentries: 'acceptMultipleEntries',
    launchdate: 'launchDate',
    closedate: 'closeDate',
    mode: 'mode',
    visibleonreportbot: 'visibleOnReportBot',
    isactive: 'isActive',
    downloadresponse: 'downloadResponse',
    geofencing: 'geoFencing',
    geotagging: 'geoTagging',
    testsurvey: 'testSurvey'
  };
  return mapping[normalized] || columnName;
}

// Map Question column names to field names
function mapQuestionColumnToField(columnName) {
  const normalized = normalizeHeaderKey(columnName);
  const optionMatch = normalized.match(/^option(\d+)(inenglish|children)?$/);
  if (optionMatch) {
    const index = optionMatch[1];
    const suffix = optionMatch[2];
    if (suffix === 'inenglish') {
      return `option${index}InEnglish`;
    }
    if (suffix === 'children') {
      return `option${index}Children`;
    }
    return `option${index}`;
  }

  const mapping = {
    surveyid: 'surveyId',
    medium: 'medium',
    mediuminenglish: 'mediumInEnglish',
    questionid: 'questionId',
    questiontype: 'questionType',
    isdynamic: 'isDynamic',
    questiondescriptionoptional: 'questionDescriptionOptional',
    maxvalue: 'maxValue',
    minvalue: 'minValue',
    ismandatory: 'isMandatory',
    tableheadervalue: 'tableHeaderValue',
    tablequestionvalue: 'tableQuestionValue',
    sourcequestion: 'sourceQuestion',
    textinputtype: 'textInputType',
    textlimitcharacters: 'textLimitCharacters',
    mode: 'mode',
    questionmedialink: 'questionMediaLink',
    questionmediatype: 'questionMediaType',
    questiondescription: 'questionDescription'
  };

  if (
    normalized.startsWith('questiondescription') &&
    normalized !== 'questiondescriptionoptional'
  ) {
    return 'questionDescription';
  }

  return mapping[normalized] || columnName;
}

function mapSurveyRecord(record) {
  const survey = {};
  Object.keys(record).forEach(key => {
    const fieldName = mapSurveyColumnToField(key);
    survey[fieldName] = record[key];
  });
  survey.mode = normalizeMode(survey.mode);
  return survey;
}

function mapQuestionRecord(record) {
  const question = {};
  Object.keys(record).forEach(key => {
    const fieldName = mapQuestionColumnToField(key);
    question[fieldName] = record[key];
  });
  return question;
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return value;

  if (value instanceof Date) {
    const day = String(value.getDate()).padStart(2, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const year = value.getFullYear();
    const hours = value.getHours();
    const minutes = value.getMinutes();
    const seconds = value.getSeconds();
    // Include time component if non-zero
    if (hours || minutes || seconds) {
      return `${day}/${month}/${year} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${day}/${month}/${year}`;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.richText) {
      return value.richText.map((part) => part.text).join('').trim();
    }
    if (value.result !== undefined) return normalizeCellValue(value.result);
    if (value.formula && value.result !== undefined) return normalizeCellValue(value.result);
    if (value.hyperlink) return String(value.text || value.hyperlink).trim();
  }

  return String(value);
}

function normalizeHeaderKey(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function inferSheetType(records, sheetType) {
  if (sheetType === 'survey' || sheetType === 'question') {
    return sheetType;
  }

  if (!records || records.length === 0) {
    return null;
  }

  const sample = records[0];
  const keys = Object.keys(sample);
  const normalizedKeys = new Set(keys.map((key) => normalizeHeaderKey(key)));
  const hasSurveyId = normalizedKeys.has('surveyid');
  const hasQuestionId = normalizedKeys.has('questionid');

  if (hasQuestionId) {
    return 'question';
  }
  if (hasSurveyId) {
    return 'survey';
  }

  return null;
}

function applyPrimaryTranslation(question) {
  const translations = question.translations || {};
  const languages = Object.keys(translations);
  const primaryLanguage = languages.includes('English') ? 'English' : (languages[0] || 'English');
  const primaryTranslation = translations[primaryLanguage] || {};

  return {
    ...question,
    medium: question.medium || primaryLanguage,
    questionDescription: primaryTranslation.questionDescription || question.questionDescription || '',
    questionDescriptionOptional: primaryTranslation.questionDescriptionOptional || question.questionDescriptionOptional || '',
    tableHeaderValue: primaryTranslation.tableHeaderValue || question.tableHeaderValue || '',
    tableQuestionValue: primaryTranslation.tableQuestionValue || question.tableQuestionValue || '',
    options: primaryTranslation.options || question.options || []
  };
}

// Parse options from question row
function parseOptions(questionRow) {
  const options = [];
  
  for (let i = 1; i <= 20; i++) {
    const optionKey = `option${i}`;
    const optionText = normalizeCellValue(questionRow[optionKey]) || normalizeCellValue(questionRow[`Option_${i}`]);
    
    if (optionText) {
      const optionInEnglishKey = `option${i}InEnglish`;
      const optionChildrenKey = `option${i}Children`;
      
      options.push({
        text: optionText,
        textInEnglish: normalizeCellValue(questionRow[optionInEnglishKey]) || normalizeCellValue(questionRow[`Option_${i}_in_English`]) || optionText,
        children: normalizeCellValue(questionRow[optionChildrenKey]) || normalizeCellValue(questionRow[`Option_${i}Children`]) || ''
      });
    }
  }
  
  return options;
}

async function runInBatches(items, batchSize, worker) {
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    await Promise.all(batch.map((item) => worker(item)));
  }
}

// Parse + validate the uploaded file. Returns either an `error` describing why
// parsing/validation could not run, or { importData, validationErrors }.
async function parseAndValidate(req) {
  if (!req.file) {
    return { error: { status: 400, body: { error: 'No file uploaded' } } };
  }

  const fileExt = path.extname(req.file.originalname || '').toLowerCase();
  const fileBuffer = req.file.buffer;

  if (!ALLOWED_UPLOAD_EXTENSIONS.has(fileExt)) {
    return { error: { status: 400, body: { error: 'Unsupported file format. Please upload XLSX or CSV file.' } } };
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return { error: { status: 400, body: { error: 'Uploaded file is empty.' } } };
  }

  let importData;

  if (fileExt === '.xlsx' || fileExt === '.xls') {
    try {
      importData = await parseXLSX(fileBuffer);
    } catch (parseErr) {
      return { error: { status: 400, body: {
        error: 'Failed to parse Excel file. The file may be corrupted or in an unsupported format.',
        message: parseErr.message
      } } };
    }

    const diag = importData.diagnostics || {};
    const sheetNames = diag.sheetNames || [];
    const surveyDiag = diag.surveySheet || { found: false };
    const questionDiag = diag.questionSheet || { found: false };

    const buildSheetError = (sheetName, sheetDiag, requiredColumns) => {
      if (!sheetDiag.found) {
        return `"${sheetName}" sheet not found. Sheets in your file: ${sheetNames.length ? sheetNames.join(', ') : '(none)'}.`;
      }
      if (sheetDiag.headers.length === 0) {
        return `"${sheetName}" sheet is empty (no header row in row 1).`;
      }
      if (sheetDiag.rowCount === 0 && sheetDiag.skippedRows > 0) {
        return `"${sheetName}" sheet has ${sheetDiag.skippedRows} data row(s), but none has a valid ${requiredColumns}. Headers found: ${sheetDiag.headers.join(', ')}.`;
      }
      if (sheetDiag.rowCount === 0) {
        return `"${sheetName}" sheet has no data rows. Headers found: ${sheetDiag.headers.join(', ')}.`;
      }
      return null;
    };

    const surveyError = buildSheetError('Survey Master', surveyDiag, 'Survey ID');
    const questionError = buildSheetError('Question Master', questionDiag, 'Survey ID and Question ID');

    if (surveyError || questionError) {
      const messages = [surveyError, questionError].filter(Boolean);
      return { error: { status: 400, body: {
        error: messages[0],
        message: messages.join(' '),
        errors: messages,
        details: {
          sheetsFound: sheetNames,
          surveySheet: surveyDiag,
          questionSheet: questionDiag
        }
      } } };
    }
  } else if (fileExt === '.csv') {
    const sheetType = req.query.sheetType || 'both';
    importData = await parseCSV(fileBuffer, sheetType);

    if (importData.surveys.length === 0 && importData.questions.length === 0) {
      return { error: { status: 400, body: {
        error: 'Could not detect CSV type. Please upload a Survey Master or Question Master CSV.'
      } } };
    }
  }

  const totalImportRows = importData.surveys.length + importData.questions.length;
  if (totalImportRows > MAX_IMPORT_ROWS) {
    return { error: { status: 413, body: {
      error: 'Import payload too large',
      message: `The uploaded file contains ${totalImportRows} rows, which exceeds the ${MAX_IMPORT_ROWS}-row import limit.`,
      details: { maxRows: MAX_IMPORT_ROWS, totalRows: totalImportRows }
    } } };
  }

  const enrichErrorsWithCells = (errors, row, fieldToCol, sheetName) => {
    return (errors || []).map(err => {
      const obj = typeof err === 'string' ? { message: err } : { ...err };
      const col = obj.field && fieldToCol ? fieldToCol[obj.field] : null;
      const cell = col ? `${col}${row}` : null;
      return {
        ...obj,
        row,
        column: col || null,
        cell,
        sheet: sheetName || null,
        message: cell
          ? `[${sheetName || 'sheet'} ${cell}] ${obj.message || ''}`
          : `[Row ${row}${obj.field ? ` · ${obj.field}` : ''}] ${obj.message || ''}`
      };
    });
  };

  const surveysForValidation = importData.surveys;
  const validationErrors = [];

  importData.surveys.forEach((survey, index) => {
    const validation = validator.validateSurvey(survey);
    if (!validation.isValid) {
      const row = survey._sourceRow || (index + 2);
      validationErrors.push({
        type: 'survey',
        index: row,
        row,
        sheet: survey._sheet || 'Survey Master',
        surveyId: survey.surveyId || `(Row ${row})`,
        errors: enrichErrorsWithCells(validation.errors, row, survey._fieldToCol, survey._sheet)
      });
    }
  });

  importData.questions.forEach((question, index) => {
    const validation = validator.validateQuestion(question, surveysForValidation, importData.questions);
    if (!validation.isValid) {
      const row = question._sourceRow || (index + 2);
      validationErrors.push({
        type: 'question',
        index: row,
        row,
        sheet: question._sheet || 'Question Master',
        surveyId: question.surveyId || '',
        questionId: question.questionId || `(Row ${row})`,
        errors: enrichErrorsWithCells(validation.errors, row, question._fieldToCol, question._sheet)
      });
    }
  });

  return { importData, validationErrors };
}

function stripInternalFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { _sourceRow, _sheet, _fieldToCol, ...rest } = obj;
  return rest;
}

function parseSurveyIdsParam(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

// POST /api/import/validate-dump - Parse + validate without persisting. Only
// returns errors for rows whose `mode` is "Correction" or "New Data" (rows
// flagged "None" or with no mode are ignored). Used by the dump-sheet
// validator UI to surface issues without writing anything to the database.
router.post('/validate-dump', importUploadMiddleware, async (req, res) => {
  try {
    const result = await parseAndValidate(req);
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    const { importData, validationErrors } = result;
    const allowedModes = new Set(['Correction', 'New Data']);

    const surveyModeById = new Map(
      importData.surveys.map(s => [s.surveyId, String(s.mode || '').trim()])
    );
    const questionModeByKey = new Map(
      importData.questions.map(q => [`${q.surveyId}::${q.questionId}`, String(q.mode || '').trim()])
    );

    const filteredErrors = validationErrors.filter(e => {
      if (e.type === 'survey') {
        return allowedModes.has(surveyModeById.get(e.surveyId));
      }
      if (e.type === 'question') {
        return allowedModes.has(questionModeByKey.get(`${e.surveyId}::${e.questionId}`));
      }
      return false;
    });

    const consideredQuestions = importData.questions.filter(q => allowedModes.has(String(q.mode || '').trim())).length;
    const consideredSurveys = importData.surveys.filter(s => allowedModes.has(String(s.mode || '').trim())).length;

    return res.json({
      validationErrors: filteredErrors,
      surveysCount: consideredSurveys,
      questionsCount: consideredQuestions,
      totalSurveys: importData.surveys.length,
      totalQuestions: importData.questions.length
    });
  } catch (error) {
    console.error('Validate-dump error:', error);
    res.status(500).json({
      error: 'Failed to validate file',
      message: error.message
    });
  }
});

// POST /api/import/preview - Parse + validate without persisting. Returns the
// list of surveys/questions found in the file and any validation errors so the
// client can let the user pick which surveys to actually import.
router.post('/preview', importUploadMiddleware, async (req, res) => {
  try {
    const result = await parseAndValidate(req);
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    const { importData, validationErrors } = result;
    const surveys = importData.surveys.map(stripInternalFields);
    const questions = importData.questions.map(stripInternalFields);

    return res.json({
      surveys,
      questions,
      validationErrors,
      surveysCount: surveys.length,
      questionsCount: questions.length
    });
  } catch (error) {
    console.error('Import preview error:', error);
    res.status(500).json({
      error: 'Failed to preview file',
      message: error.message
    });
  }
});

// POST /api/import - Import survey from XLSX/CSV
router.post('/', importUploadMiddleware, async (req, res) => {
  try {
    const overwrite = String(req.query.overwrite || '').toLowerCase() === 'true';

    const result = await parseAndValidate(req);
    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    let { importData, validationErrors } = result;

    // Apply optional surveyIds filter — when present, only import the listed
    // surveys (and questions belonging to them); errors are filtered too.
    const selectedSurveyIds = parseSurveyIdsParam(req.query.surveyIds || (req.body && req.body.surveyIds));
    if (selectedSurveyIds && selectedSurveyIds.length > 0) {
      const idSet = new Set(selectedSurveyIds);
      importData.surveys = importData.surveys.filter(s => idSet.has(s.surveyId));
      importData.questions = importData.questions.filter(q => idSet.has(q.surveyId));
      validationErrors = validationErrors.filter(e => idSet.has(e.surveyId));

      if (importData.surveys.length === 0) {
        return res.status(400).json({
          error: 'No surveys to import',
          message: 'None of the selected Survey IDs were found in the uploaded file.',
          details: { selectedSurveyIds }
        });
      }
    }

    // Check for duplicate survey IDs (targeted query instead of loading all surveys)
    const incomingSurveyIds = importData.surveys.map((survey) => survey.surveyId);
    const duplicateSurveyIds = await findExistingSurveyIds(incomingSurveyIds);

    if (duplicateSurveyIds.length > 0 && !overwrite) {
      return res.status(400).json({
        error: 'Duplicate survey IDs found',
        message: 'Import rejected because one or more Survey IDs already exist. Retry with overwrite=true to replace existing surveys.',
        details: [
          {
            field: 'surveyId',
            duplicates: [...new Set(duplicateSurveyIds)]
          }
        ],
        validationErrors: duplicateSurveyIds.map((surveyId) => ({
          type: 'survey',
          surveyId,
          errors: ['Survey ID already exists in the system']
        })),
        surveysCount: importData.surveys.length,
        questionsCount: importData.questions.length
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        validationErrors,
        surveysCount: importData.surveys.length,
        questionsCount: importData.questions.length
      });
    }

    // Auto-set stateCode for non-admin users
    if (req.user && req.user.role !== 'admin' && req.user.stateCode) {
      importData.surveys.forEach(s => { s.stateCode = req.user.stateCode; });
    }

    // Ensure publish default
    importData.surveys.forEach(s => {
      if (!s.publish) s.publish = { status: 'DRAFT' };
    });

    // Clean internal fields before persisting
    importData.surveys.forEach(s => {
      delete s._sourceRow;
      delete s._sheet;
      delete s._fieldToCol;
    });
    importData.questions.forEach(q => {
      delete q._sourceRow;
      delete q._sheet;
      delete q._fieldToCol;
    });

    // Import data using targeted upserts (non-destructive)
    if (overwrite) {
      // Delete existing surveys that will be replaced (cascade deletes their questions)
      const toDelete = duplicateSurveyIds.filter(id => incomingSurveyIds.includes(id));
      await runInBatches(toDelete, UPSERT_BATCH_SIZE, (surveyId) => deleteSurvey(surveyId));
    }

    await runInBatches(importData.surveys, UPSERT_BATCH_SIZE, (survey) => upsertSurvey(survey));
    await runInBatches(importData.questions, UPSERT_BATCH_SIZE, (question) => upsertQuestion(question));

    logAudit(req, {
      action: 'import.commit',
      entityType: 'import',
      entityId: null,
      metadata: {
        overwrite,
        surveysImported: importData.surveys.length,
        questionsImported: importData.questions.length,
        surveyIds: importData.surveys.map(s => s.surveyId)
      }
    });

    res.status(201).json({
      message: 'Import successful',
      overwrite,
      surveysImported: importData.surveys.length,
      questionsImported: importData.questions.length,
      surveys: importData.surveys
    });

  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({
      error: 'Failed to import file',
      message: error.message
    });
  }
});

module.exports = router;
