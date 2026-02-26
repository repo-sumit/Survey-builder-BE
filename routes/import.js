const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const fsp = require('fs').promises;
const path = require('path');
const validator = require('../services/validator');
const store = require('../data/store');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      store.ensureUploadsDir()
        .then(() => cb(null, store.UPLOAD_DIR))
        .catch((error) => cb(error));
    }
  })
});

// Helper function to parse XLSX file
async function parseXLSX(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  
  const result = { surveys: [], questions: [] };
  
  const surveySheet = workbook.getWorksheet('Survey Master');
  if (surveySheet) {
    const headers = [];
    surveySheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = normalizeCellValue(cell.value);
    });
    
    surveySheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const survey = {};
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber];
        if (header) {
          const fieldName = mapSurveyColumnToField(header);
          survey[fieldName] = normalizeCellValue(cell.value);
        }
      });
      if (survey.surveyId) {
        result.surveys.push(survey);
      }
    });
  }
  
  const questionSheet = workbook.getWorksheet('Question Master');
  if (questionSheet) {
    const headers = [];
    questionSheet.getRow(1).eachCell((cell, colNumber) => {
      headers[colNumber] = normalizeCellValue(cell.value);
    });
    
    const questionsByKey = {};
    
    questionSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const questionRow = {};
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber];
        if (header) {
          const fieldName = mapQuestionColumnToField(header);
          questionRow[fieldName] = normalizeCellValue(cell.value);
        }
      });
      
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
    
    result.questions = Object.values(questionsByKey).map(applyPrimaryTranslation);
  }
  
  return result;
}

async function parseCSV(filePath, sheetType) {
  const fileContent = await fsp.readFile(filePath, 'utf8');
  const records = parse(fileContent, { columns: true, skip_empty_lines: true, trim: true });
  const inferredType = inferSheetType(records, sheetType);

  if (inferredType === 'survey') {
    return { surveys: records.map(mapSurveyRecord), questions: [] };
  } else if (inferredType === 'question') {
    const questionsByKey = {};
    records.forEach(record => {
      const questionRow = mapQuestionRecord(record);
      if (questionRow.surveyId && questionRow.questionId) {
        const key = `${questionRow.surveyId}_${questionRow.questionId}_${questionRow.questionType}`;
        if (!questionsByKey[key]) {
          questionsByKey[key] = {
            surveyId: questionRow.surveyId, questionId: questionRow.questionId,
            questionType: questionRow.questionType, isDynamic: questionRow.isDynamic,
            isMandatory: questionRow.isMandatory, sourceQuestion: questionRow.sourceQuestion || '',
            textInputType: questionRow.textInputType || 'None', textLimitCharacters: questionRow.textLimitCharacters || '',
            maxValue: questionRow.maxValue || '', minValue: questionRow.minValue || '',
            tableHeaderValue: questionRow.tableHeaderValue || '', tableQuestionValue: questionRow.tableQuestionValue || '',
            questionMediaLink: questionRow.questionMediaLink || '', questionMediaType: questionRow.questionMediaType || 'None',
            mode: questionRow.mode || 'None', translations: {}
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

function mapSurveyColumnToField(columnName) {
  const normalized = normalizeHeaderKey(columnName);
  const mapping = {
    surveyid: 'surveyId', surveyname: 'surveyName', surveydescription: 'surveyDescription',
    availablemediums: 'availableMediums', hierarchicalaccesslevel: 'hierarchicalAccessLevel',
    public: 'public', inschool: 'inSchool', acceptmultipleentries: 'acceptMultipleEntries',
    launchdate: 'launchDate', closedate: 'closeDate', mode: 'mode',
    visibleonreportbot: 'visibleOnReportBot', isactive: 'isActive',
    downloadresponse: 'downloadResponse', geofencing: 'geoFencing',
    geotagging: 'geoTagging', testsurvey: 'testSurvey'
  };
  return mapping[normalized] || columnName;
}

function mapQuestionColumnToField(columnName) {
  const normalized = normalizeHeaderKey(columnName);
  const optionMatch = normalized.match(/^option(\d+)(inenglish|children)?$/);
  if (optionMatch) {
    const index = optionMatch[1];
    const suffix = optionMatch[2];
    if (suffix === 'inenglish') return `option${index}InEnglish`;
    if (suffix === 'children') return `option${index}Children`;
    return `option${index}`;
  }
  const mapping = {
    surveyid: 'surveyId', medium: 'medium', mediuminenglish: 'mediumInEnglish',
    questionid: 'questionId', questiontype: 'questionType', isdynamic: 'isDynamic',
    questiondescriptionoptional: 'questionDescriptionOptional', maxvalue: 'maxValue',
    minvalue: 'minValue', ismandatory: 'isMandatory', tableheadervalue: 'tableHeaderValue',
    tablequestionvalue: 'tableQuestionValue', sourcequestion: 'sourceQuestion',
    textinputtype: 'textInputType', textlimitcharacters: 'textLimitCharacters',
    mode: 'mode', questionmedialink: 'questionMediaLink', questionmediatype: 'questionMediaType',
    questiondescription: 'questionDescription'
  };
  if (normalized.startsWith('questiondescription') && normalized !== 'questiondescriptionoptional') {
    return 'questionDescription';
  }
  return mapping[normalized] || columnName;
}

function mapSurveyRecord(record) {
  const survey = {};
  Object.keys(record).forEach(key => { survey[mapSurveyColumnToField(key)] = record[key]; });
  return survey;
}

function mapQuestionRecord(record) {
  const question = {};
  Object.keys(record).forEach(key => { question[mapQuestionColumnToField(key)] = record[key]; });
  return question;
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) {
    const day = String(value.getDate()).padStart(2, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const year = value.getFullYear();
    return `${day}/${month}/${year}`;
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    if (value.text) return value.text;
    if (value.richText) return value.richText.map((part) => part.text).join('');
    if (value.result !== undefined) return value.result;
    if (value.formula && value.result !== undefined) return value.result;
    if (value.hyperlink) return value.text || value.hyperlink;
  }
  return value;
}

function normalizeHeaderKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase().replace(/[\s_]+/g, '').replace(/[^a-z0-9]/g, '');
}

function inferSheetType(records, sheetType) {
  if (sheetType === 'survey' || sheetType === 'question') return sheetType;
  if (!records || records.length === 0) return null;
  const sample = records[0];
  const normalizedKeys = new Set(Object.keys(sample).map(normalizeHeaderKey));
  if (normalizedKeys.has('questionid')) return 'question';
  if (normalizedKeys.has('surveyid')) return 'survey';
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

function parseOptions(questionRow) {
  const options = [];
  for (let i = 1; i <= 20; i++) {
    const optionText = normalizeCellValue(questionRow[`option${i}`]) || normalizeCellValue(questionRow[`Option_${i}`]);
    if (optionText) {
      options.push({
        text: optionText,
        textInEnglish: normalizeCellValue(questionRow[`option${i}InEnglish`]) || normalizeCellValue(questionRow[`Option_${i}_in_English`]) || optionText,
        children: normalizeCellValue(questionRow[`option${i}Children`]) || normalizeCellValue(questionRow[`Option_${i}Children`]) || ''
      });
    }
  }
  return options;
}

// POST /api/import - Import survey from XLSX/CSV
router.post('/', upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const overwrite = String(req.query.overwrite || '').toLowerCase() === 'true';
    filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let importData;
    
    if (fileExt === '.xlsx' || fileExt === '.xls') {
      importData = await parseXLSX(filePath);
      if (importData.surveys.length === 0 || importData.questions.length === 0) {
        return res.status(400).json({
          error: 'Survey Master and Question Master sheets are required for Excel imports.',
          details: { hasSurveyMaster: importData.surveys.length > 0, hasQuestionMaster: importData.questions.length > 0 }
        });
      }
    } else if (fileExt === '.csv') {
      importData = await parseCSV(filePath, req.query.sheetType || 'both');
    } else {
      return res.status(400).json({ error: 'Unsupported file format. Please upload XLSX or CSV file.' });
    }
    
    if (fileExt === '.csv' && importData.surveys.length === 0 && importData.questions.length === 0) {
      return res.status(400).json({ error: 'Could not detect CSV type. Please upload a Survey Master or Question Master CSV.' });
    }

    // Check for duplicates
    const errors = [];
    const incomingSurveyIds = importData.surveys.map(s => s.surveyId);
    const duplicateSurveyIds = [];

    for (const sid of incomingSurveyIds) {
      if (await store.surveyExists(sid)) {
        duplicateSurveyIds.push(sid);
      }
    }

    if (duplicateSurveyIds.length > 0 && !overwrite) {
      return res.status(400).json({
        error: 'Duplicate survey IDs found',
        message: 'Import rejected because one or more Survey IDs already exist. Retry with overwrite=true to replace existing surveys.',
        details: [{ field: 'surveyId', duplicates: [...new Set(duplicateSurveyIds)] }],
        validationErrors: duplicateSurveyIds.map(surveyId => ({
          type: 'survey', surveyId, errors: ['Survey ID already exists in the system']
        })),
        surveysCount: importData.surveys.length,
        questionsCount: importData.questions.length
      });
    }

    // Build full list for validation
    const existingSurveys = await store.getAllSurveys();
    const existingQuestions = await store.getAllQuestions();

    // Filter out surveys/questions that will be overwritten
    const overwriteSet = new Set(duplicateSurveyIds);
    const surveysForValidation = [
      ...existingSurveys.filter(s => !overwriteSet.has(s.surveyId)),
      ...importData.surveys
    ];
    const questionsForValidation = [
      ...existingQuestions.filter(q => !overwriteSet.has(q.surveyId)),
      ...importData.questions
    ];
    
    // Validate surveys
    importData.surveys.forEach((survey, index) => {
      const validation = validator.validateSurvey(survey);
      if (!validation.isValid) {
        errors.push({ type: 'survey', index: index + 1, surveyId: survey.surveyId, errors: validation.errors });
      }
    });
    
    // Validate questions
    importData.questions.forEach((question, index) => {
      const validation = validator.validateQuestion(question, surveysForValidation, questionsForValidation);
      if (!validation.isValid) {
        errors.push({ type: 'question', index: index + 1, questionId: question.questionId, errors: validation.errors });
      }
    });
    
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed', validationErrors: errors,
        surveysCount: importData.surveys.length, questionsCount: importData.questions.length
      });
    }
    
    // Bulk import with transaction
    await store.bulkImport(importData.surveys, importData.questions, duplicateSurveyIds);
    
    res.status(201).json({
      message: 'Import successful', overwrite,
      surveysImported: importData.surveys.length,
      questionsImported: importData.questions.length,
      surveys: importData.surveys
    });
    
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Failed to import file', message: error.message });
  } finally {
    if (filePath) {
      try { await fsp.unlink(filePath); } catch (err) { console.error('Failed to delete uploaded file:', err); }
    }
  }
});

module.exports = router;
