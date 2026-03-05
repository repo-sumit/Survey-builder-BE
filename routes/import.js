const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const path = require('path');
const validator = require('../services/validator');
const { upsertSurvey, upsertQuestion, listSurveys, deleteSurvey } = require('../data/store');

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

// Helper function to parse XLSX file
async function parseXLSX(fileBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);

  const result = { surveys: [], questions: [], diagnostics: { sheetNames: workbook.worksheets.map(s => s.name) } };

  // Parse Survey Master sheet (case-insensitive, trim-aware)
  const surveySheet = findWorksheet(workbook, 'Survey Master');
  if (surveySheet) {
    const headers = [];
    surveySheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = normalizeCellValue(cell.value);
    });

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
        survey._sourceRow = rowNumber;
        result.surveys.push(survey);
      }
    });
  }

  // Parse Question Master sheet (case-insensitive, trim-aware)
  const questionSheet = findWorksheet(workbook, 'Question Master');
  if (questionSheet) {
    const headers = [];
    questionSheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = normalizeCellValue(cell.value);
    });

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

      if (questionRow.surveyId && questionRow.questionId) {
        const key = `${questionRow.surveyId}_${questionRow.questionId}_${questionRow.questionType}`;

        if (!questionsByKey[key]) {
          questionsByKey[key] = {
            surveyId: questionRow.surveyId,
            questionId: questionRow.questionId,
            questionType: questionRow.questionType,
            isDynamic: questionRow.isDynamic,
            isMandatory: questionRow.isMandatory,
            sourceQuestion: questionRow.sourceQuestion || '',
            textInputType: normalizeTextInputType(questionRow.textInputType) || 'None',
            textLimitCharacters: String(questionRow.textLimitCharacters || ''),
            maxValue: String(questionRow.maxValue || ''),
            minValue: String(questionRow.minValue || ''),
            tableHeaderValue: questionRow.tableHeaderValue || '',
            tableQuestionValue: questionRow.tableQuestionValue || '',
            questionMediaLink: questionRow.questionMediaLink || '',
            questionMediaType: questionRow.questionMediaType || 'None',
            mode: questionRow.mode || 'None',
            translations: {},
            _sourceRow: rowNumber
          };
        }

        // Add translation for this language
        const language = questionRow.mediumInEnglish || questionRow.medium || 'English';
        questionsByKey[key].translations[language] = {
          questionDescription: questionRow.questionDescription || '',
          questionDescriptionOptional: questionRow.questionDescriptionOptional || '',
          tableHeaderValue: questionRow.tableHeaderValue || '',
          tableQuestionValue: questionRow.tableQuestionValue || '',
          options: parseOptions(questionRow)
        };
      }
    });

    result.questions = Object.values(questionsByKey).map(applyPrimaryTranslation);
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
            isMandatory: questionRow.isMandatory,
            sourceQuestion: questionRow.sourceQuestion || '',
            textInputType: questionRow.textInputType || 'None',
            textLimitCharacters: questionRow.textLimitCharacters || '',
            maxValue: questionRow.maxValue || '',
            minValue: questionRow.minValue || '',
            tableHeaderValue: questionRow.tableHeaderValue || '',
            tableQuestionValue: questionRow.tableQuestionValue || '',
            questionMediaLink: questionRow.questionMediaLink || '',
            questionMediaType: questionRow.questionMediaType || 'None',
            mode: questionRow.mode || 'None',
            translations: {}
          };
        }
        
        const language = questionRow.mediumInEnglish || questionRow.medium || 'English';
        questionsByKey[key].translations[language] = {
          questionDescription: questionRow.questionDescription || '',
          questionDescriptionOptional: questionRow.questionDescriptionOptional || '',
          tableHeaderValue: questionRow.tableHeaderValue || '',
          tableQuestionValue: questionRow.tableQuestionValue || '',
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

// POST /api/import - Import survey from XLSX/CSV
router.post('/', importUploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const overwrite = String(req.query.overwrite || '').toLowerCase() === 'true';
    const fileExt = path.extname(req.file.originalname || '').toLowerCase();
    const fileBuffer = req.file.buffer;

    if (!ALLOWED_UPLOAD_EXTENSIONS.has(fileExt)) {
      return res.status(400).json({ error: 'Unsupported file format. Please upload XLSX or CSV file.' });
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ error: 'Uploaded file is empty.' });
    }

    let importData;

    if (fileExt === '.xlsx' || fileExt === '.xls') {
      try {
        importData = await parseXLSX(fileBuffer);
      } catch (parseErr) {
        return res.status(400).json({
          error: 'Failed to parse Excel file. The file may be corrupted or in an unsupported format.',
          message: parseErr.message
        });
      }

      if (importData.surveys.length === 0 && importData.questions.length === 0) {
        return res.status(400).json({
          error: 'No data found. Ensure the file has "Survey Master" and "Question Master" sheets.',
          details: {
            sheetsFound: importData.diagnostics?.sheetNames || [],
            hasSurveyMaster: false,
            hasQuestionMaster: false
          }
        });
      }

      // Allow import with only surveys or only questions (e.g., adding questions to existing surveys)
      if (importData.surveys.length === 0) {
        return res.status(400).json({
          error: 'No "Survey Master" sheet found. Excel imports require both Survey Master and Question Master sheets.',
          details: {
            sheetsFound: importData.diagnostics?.sheetNames || [],
            hasSurveyMaster: false,
            hasQuestionMaster: importData.questions.length > 0
          }
        });
      }
      if (importData.questions.length === 0) {
        return res.status(400).json({
          error: 'No "Question Master" sheet found. Excel imports require both Survey Master and Question Master sheets.',
          details: {
            sheetsFound: importData.diagnostics?.sheetNames || [],
            hasSurveyMaster: importData.surveys.length > 0,
            hasQuestionMaster: false
          }
        });
      }
    } else if (fileExt === '.csv') {
      const sheetType = req.query.sheetType || 'both';
      importData = await parseCSV(fileBuffer, sheetType);
    }

    if (fileExt === '.csv' && importData.surveys.length === 0 && importData.questions.length === 0) {
      return res.status(400).json({
        error: 'Could not detect CSV type. Please upload a Survey Master or Question Master CSV.'
      });
    }

    const totalImportRows = importData.surveys.length + importData.questions.length;
    if (totalImportRows > MAX_IMPORT_ROWS) {
      return res.status(413).json({
        error: 'Import payload too large',
        message: `The uploaded file contains ${totalImportRows} rows, which exceeds the ${MAX_IMPORT_ROWS}-row import limit.`,
        details: {
          maxRows: MAX_IMPORT_ROWS,
          totalRows: totalImportRows
        }
      });
    }

    // Check for duplicate survey IDs
    const existingSurveys = await listSurveys();
    const incomingSurveyIds = new Set(importData.surveys.map((survey) => survey.surveyId));
    const duplicateSurveyIds = existingSurveys
      .filter((survey) => incomingSurveyIds.has(survey.surveyId))
      .map((survey) => survey.surveyId);

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

    // Build validation context
    const otherSurveys = overwrite
      ? existingSurveys.filter(s => !incomingSurveyIds.has(s.surveyId))
      : existingSurveys;
    const surveysForValidation = [...otherSurveys, ...importData.surveys];

    // Validate surveys
    const errors = [];
    importData.surveys.forEach((survey, index) => {
      const validation = validator.validateSurvey(survey);
      if (!validation.isValid) {
        errors.push({
          type: 'survey',
          index: survey._sourceRow || (index + 2),
          surveyId: survey.surveyId || `(Row ${index + 2})`,
          errors: validation.errors
        });
      }
    });

    // Validate questions
    importData.questions.forEach((question, index) => {
      const validation = validator.validateQuestion(question, surveysForValidation, importData.questions);
      if (!validation.isValid) {
        errors.push({
          type: 'question',
          index: question._sourceRow || (index + 2),
          questionId: question.questionId || `(Row ${index + 2})`,
          errors: validation.errors
        });
      }
    });

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        validationErrors: errors,
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
    importData.surveys.forEach(s => { delete s._sourceRow; });
    importData.questions.forEach(q => { delete q._sourceRow; });

    // Import data using targeted upserts (non-destructive)
    if (overwrite) {
      // Delete existing surveys that will be replaced (cascade deletes their questions)
      await runInBatches(duplicateSurveyIds, UPSERT_BATCH_SIZE, (surveyId) => deleteSurvey(surveyId));
    }

    await runInBatches(importData.surveys, UPSERT_BATCH_SIZE, (survey) => upsertSurvey(survey));
    await runInBatches(importData.questions, UPSERT_BATCH_SIZE, (question) => upsertQuestion(question));

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
