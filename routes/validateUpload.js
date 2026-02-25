const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const validationEngine = require('../validation/validationEngine');
const path = require('path');

const SUPPORTED_SCHEMAS = ['survey', 'question', 'both'];
const SURVEY_SCHEMA_HEADERS = new Set([
  'surveyid',
  'surveyname',
  'surveydescription',
  'availablemediums',
  'public',
  'inschool',
  'acceptmultipleentries',
  'launchdate',
  'closedate'
]);
const QUESTION_SCHEMA_HEADERS = new Set([
  'questionid',
  'questiontype',
  'questiondescription',
  'medium',
  'ismandatory',
  'sourcequestion',
  'tableheadervalue',
  'tablequestionvalue',
  'options'
]);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  }
});

/**
 * POST /api/validate-upload
 * Query params: schema=survey|question|both
 * Body: multipart/form-data with file
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const schema = req.query.schema || 'both';
    if (!SUPPORTED_SCHEMAS.includes(schema)) {
      return res.status(400).json({
        error: 'Invalid schema query parameter',
        message: 'schema must be one of: survey, question, both',
        details: [{ field: 'schema', value: schema }],
        errors: ['schema must be one of: survey, question, both']
      });
    }

    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let surveyData = [];
    let questionData = [];

    // Parse file based on type
    if (fileExt === '.csv') {
      const csvContent = req.file.buffer.toString('utf-8');
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      if (records.length > 0) {
        const detectedSchema = detectCsvSchema(records, schema);

        if (!detectedSchema) {
          return res.status(400).json({
            error: 'Unable to detect CSV schema',
            message: 'CSV headers do not match Survey Master or Question Master. Use ?schema=survey or ?schema=question to force schema selection.',
            details: [{ schema, headers: Object.keys(records[0] || {}) }],
            errors: ['CSV schema detection failed']
          });
        }

        if (detectedSchema === 'survey') {
          surveyData = records.map((record, index) => {
            const normalized = normalizeKeys(record);
            normalized._excelRow = index + 2; // +2 for header row and 0-index
            normalized._sheetName = 'CSV';
            return normalized;
          });
        } else if (detectedSchema === 'question') {
          questionData = records.map((record, index) => {
            const normalized = normalizeKeys(record);
            normalized._excelRow = index + 2; // +2 for header row and 0-index
            normalized._sheetName = 'CSV';
            return normalized;
          });
        }
      }
    } else if (fileExt === '.xlsx' || fileExt === '.xls') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);

      // Check for SurveyMaster sheet (case insensitive, various formats)
      const surveySheet = workbook.worksheets.find(ws => 
        ws.name.toLowerCase().replace(/\s+/g, '') === 'surveymaster' ||
        ws.name.toLowerCase().replace(/\s+/g, '') === 'survey'
      );
      
      if (surveySheet) {
        surveyData = parseExcelSheet(surveySheet, surveySheet.name);
      }

      // Check for QuestionMaster sheet (case insensitive, various formats)
      const questionSheet = workbook.worksheets.find(ws => 
        ws.name.toLowerCase().replace(/\s+/g, '') === 'questionmaster' ||
        ws.name.toLowerCase().replace(/\s+/g, '') === 'question'
      );
      
      if (questionSheet) {
        questionData = parseExcelSheet(questionSheet, questionSheet.name);
      }

      // Ignore Access sheet and Designation mapping tabs as per requirements
      // These sheets will not be processed or validated
    }

    // Validate based on schema parameter
    let allErrors = [];
    let totalRows = 0;

    if (schema === 'survey' || schema === 'both') {
      if (surveyData.length > 0) {
        totalRows += surveyData.length;
        const surveyErrors = validationEngine.validateBulkSurveys(surveyData);
        // Update errors with Excel row numbers if available
        surveyErrors.forEach(error => {
          const record = surveyData[error.row - 2]; // error.row is index + 2, so we get index back
          if (record && record._excelRow) {
            error.row = record._excelRow; // Use actual Excel row number
          }
          if (record && record._sheetName) {
            error.sheet = record._sheetName; // Use actual sheet name
          }
          if (record) {
            error.surveyId = record.surveyId || '';
            error.surveyName = record.surveyName || '';
          }
        });
        allErrors = allErrors.concat(surveyErrors);
      }
    }

    if (schema === 'question' || schema === 'both') {
      if (questionData.length > 0) {
        totalRows += questionData.length;
        const questionErrors = validationEngine.validateBulkQuestions(questionData, surveyData);
        // Update errors with Excel row numbers if available
        questionErrors.forEach(error => {
          const record = questionData[error.row - 2]; // error.row is index + 2, so we get index back
          if (record && record._excelRow) {
            error.row = record._excelRow; // Use actual Excel row number
          }
          if (record && record._sheetName) {
            error.sheet = record._sheetName; // Use actual sheet name
          }
          if (record) {
            error.surveyId = record.surveyId || '';
            error.questionId = record.questionId || '';
            error.questionType = record.questionType || '';
            error.medium = record.medium || '';
          }
        });
        allErrors = allErrors.concat(questionErrors);
      }
    }

    // Calculate summary
    const errorRows = new Set(allErrors.map(e => e.row)).size;
    const summary = {
      totalRows,
      errorRows,
      totalErrors: allErrors.length
    };

    res.json({
      isValid: allErrors.length === 0,
      summary,
      errors: allErrors
    });

  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({ 
      error: 'Failed to validate upload', 
      message: error.message 
    });
  }
});

/**
 * Parse Excel sheet to array of objects
 */
function parseExcelSheet(sheet, sheetName) {
  const data = [];
  const headers = [];

  // Get headers from first row
  const firstRow = sheet.getRow(1);
  firstRow.eachCell((cell, colNumber) => {
    headers[colNumber] = cell.value;
  });

  // Parse data rows
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header row

    const record = {};
    let hasData = false;
    row.eachCell((cell, colNumber) => {
      const header = headers[colNumber];
      if (header) {
        record[header] = cell.value;
        if (cell.value !== null && cell.value !== undefined && cell.value !== '') {
          hasData = true;
        }
      }
    });

    // Only add non-empty rows, and include the Excel row number and sheet name
    if (hasData) {
      const normalized = normalizeKeys(record);
      normalized._excelRow = rowNumber; // Track the Excel row number
      normalized._sheetName = sheetName; // Track the sheet name
      data.push(normalized);
    }
  });

  return data;
}

function normalizeHeaderKey(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function countMatchingHeaders(headers, expectedHeaders) {
  return headers.reduce((count, header) => (
    expectedHeaders.has(header) ? count + 1 : count
  ), 0);
}

function detectCsvSchema(records, requestedSchema) {
  if (requestedSchema === 'survey' || requestedSchema === 'question') {
    return requestedSchema;
  }

  if (!records || records.length === 0) {
    return null;
  }

  const normalizedHeaders = Object.keys(records[0]).map(normalizeHeaderKey);
  const surveyMatches = countMatchingHeaders(normalizedHeaders, SURVEY_SCHEMA_HEADERS);
  const questionMatches = countMatchingHeaders(normalizedHeaders, QUESTION_SCHEMA_HEADERS);
  const hasSurveyId = normalizedHeaders.includes('surveyid');
  const hasQuestionId = normalizedHeaders.includes('questionid');

  if (surveyMatches >= 2 && questionMatches < 2) {
    return 'survey';
  }

  if (questionMatches >= 2 && surveyMatches < 2) {
    return 'question';
  }

  // Backward-compatible fallback for older CSV files with sparse headers.
  if (hasQuestionId && !hasSurveyId) {
    return 'question';
  }

  if (hasSurveyId && !hasQuestionId) {
    return 'survey';
  }

  return null;
}

/**
 * Normalize CSV/Excel keys to match internal format
 * Converts "Survey ID" -> "surveyId", handles various formats
 */
function normalizeKeys(record) {
  const normalized = {};
  
  const keyMap = {
    'Survey ID': 'surveyId',
    'Survey Name': 'surveyName',
    'Survey Description': 'surveyDescription',
    'available_mediums': 'availableMediums',
    'Available Mediums': 'availableMediums',
    'Hierarchial Access Level': 'hierarchicalAccessLevel',
    'Hierarchical Access Level': 'hierarchicalAccessLevel',
    'Public': 'public',
    'In School': 'inSchool',
    'Accept multiple Entries': 'acceptMultipleEntries',
    'Accept Multiple Entries': 'acceptMultipleEntries',
    'Launch Date': 'launchDate',
    'Close Date': 'closeDate',
    'Mode': 'mode',
    'visible_on_report_bot': 'visibleOnReportBot',
    'Visible on Report Bot': 'visibleOnReportBot',
    'Is Active?': 'isActive',
    'Is Active': 'isActive',
    'Download_response': 'downloadResponse',
    'Download Response': 'downloadResponse',
    'Geo Fencing': 'geoFencing',
    'Geo Tagging': 'geoTagging',
    'Test Survey': 'testSurvey',
    
    // Question fields
    'Question ID': 'questionId',
    'Medium': 'medium',
    'Question Type': 'questionType',
    'Question Description': 'questionDescription',
    'Text_input_type': 'textInputType',
    'Text Input Type': 'textInputType',
    'Is Mandatory': 'isMandatory',
    'Is_Mandatory': 'isMandatory',
    'Options': 'options',
    'Source_Question': 'sourceQuestion',
    'Source Question': 'sourceQuestion',
    'Table_Header_value': 'tableHeaderValue',
    'Table Header Value': 'tableHeaderValue',
    'Table_Question_value': 'tableQuestionValue',
    'Table Question Value': 'tableQuestionValue',
    'Question_Media_Type': 'questionMediaType',
    'Question Media Type': 'questionMediaType',
    'Question_Media_Link': 'questionMediaLink',
    'Question Media Link': 'questionMediaLink'
  };

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = keyMap[key] || key;
    
    // Handle array fields
    if (normalizedKey === 'options' && typeof value === 'string') {
      normalized[normalizedKey] = value.split(',').map(o => o.trim()).filter(o => o);
    } else if (normalizedKey === 'availableMediums' && typeof value === 'string') {
      // Keep as string for validation
      normalized[normalizedKey] = value;
    } else {
      // Convert to string and trim
      normalized[normalizedKey] = value !== null && value !== undefined ? String(value).trim() : '';
    }
  }

  return normalized;
}

module.exports = router;
