/**
 * Comprehensive Validation Engine for FMB Survey Builder
 * Provides centralized validation for Survey Master and Question Master
 */

// Supported languages/mediums
const AVAILABLE_MEDIUMS = [
  'English', 'Hindi', 'Gujarati', 'Marathi', 'Tamil', 
  'Telugu', 'Bengali', 'Bodo', 'Punjabi', 'Assamese'
];

// Question types
const QUESTION_TYPES = [
  'Multiple Choice Single Select',
  'Multiple Choice Multi Select',
  'Tabular Text Input',
  'Tabular Drop Down',
  'Tabular Check Box',
  'Text Response',
  'Image Upload',
  'Video Upload',
  'Voice Response',
  'Likert Scale',
  'Calendar',
  'Drop Down'
];

const TEXT_INPUT_TYPES = ['Numeric', 'Alphanumeric', 'Alphabets', 'None'];
const QUESTION_MEDIA_TYPES = ['Image', 'Video', 'Audio', 'None'];
const MODES = ['New Data', 'Correction', 'Delete Data', 'None'];
const YES_NO_VALUES = ['Yes', 'No'];

/**
 * Validation Engine Class
 */
class ValidationEngine {
  constructor() {
    // Cache validation rules
    this.surveyValidationRules = this._getSurveyValidationRules();
    this.questionValidationRules = this._getQuestionValidationRules();
  }

  /**
   * Define Survey Master validation rules
   */
  _getSurveyValidationRules() {
    return {
      surveyId: {
        type: 'required',
        pattern: /^[A-Za-z0-9_]+$/,
        message: 'Survey ID must contain only alphanumeric characters and underscores (no spaces)'
      },
      surveyName: {
        type: 'required',
        maxLength: 99,
        message: 'Survey Name is required and must not exceed 99 characters'
      },
      surveyDescription: {
        type: 'required',
        maxLength: 256,
        message: 'Survey Description is required and must not exceed 256 characters'
      },
      availableMediums: {
        type: 'required',
        custom: 'availableMediums',
        message: `Available Mediums must be from: ${AVAILABLE_MEDIUMS.join(', ')}`
      },
      hierarchicalAccessLevel: {
        type: 'optional',
        custom: 'hierarchicalAccessLevel',
        message: 'Hierarchical Access Level must be numeric values (1-7), comma-separated, no duplicates'
      },
      public: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Public must be "Yes" or "No"'
      },
      inSchool: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'In School must be "Yes" or "No"'
      },
      acceptMultipleEntries: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Accept Multiple Entries must be "Yes" or "No"'
      },
      isActive: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Is Active must be "Yes" or "No"'
      },
      downloadResponse: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Download Response must be "Yes" or "No"'
      },
      geoFencing: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Geo Fencing must be "Yes" or "No"'
      },
      geoTagging: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Geo Tagging must be "Yes" or "No"'
      },
      testSurvey: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Test Survey must be "Yes" or "No"'
      },
      visibleOnReportBot: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Visible on Report Bot must be "Yes" or "No"'
      },
      launchDate: {
        type: 'dateFormat',
        format: 'DD/MM/YYYY HH:MM:SS',
        message: 'Launch Date must be in DD/MM/YYYY HH:MM:SS or DD/MM/YYYY format'
      },
      closeDate: {
        type: 'dateFormat',
        format: 'DD/MM/YYYY HH:MM:SS',
        message: 'Close Date must be in DD/MM/YYYY HH:MM:SS or DD/MM/YYYY format'
      },
      mode: {
        type: 'enum',
        values: MODES,
        message: `Mode must be one of: ${MODES.join(', ')}`
      }
    };
  }

  /**
   * Define Question Master validation rules
   */
  _getQuestionValidationRules() {
    return {
      questionId: {
        type: 'required',
        pattern: /^Q\d+(\.\d+)*$/,
        message: 'Question ID must be in format Q1, Q1.1, Q5.2, etc.'
      },
      surveyId: {
        type: 'required',
        message: 'Survey ID is required'
      },
      medium: {
        type: 'required',
        enum: AVAILABLE_MEDIUMS,
        message: 'Medium is required and must match survey available mediums'
      },
      questionType: {
        type: 'required',
        enum: QUESTION_TYPES,
        message: `Question Type must be one of: ${QUESTION_TYPES.join(', ')}`
      },
      questionDescription: {
        type: 'required',
        maxLength: 1024,
        message: 'Question Description is required and must not exceed 1024 characters'
      },
      isMandatory: {
        type: 'enum',
        values: YES_NO_VALUES,
        message: 'Is Mandatory must be "Yes" or "No"'
      }
    };
  }

  /**
   * Validate a single survey record
   */
  validateSurvey(surveyData) {
    const errors = [];

    // Basic field validations
    for (const [field, rule] of Object.entries(this.surveyValidationRules)) {
      const value = surveyData[field];
      const fieldErrors = this._validateField(field, value, rule, surveyData);
      errors.push(...fieldErrors);
    }

    // Cross-validation: Geo Fencing/Tagging logic
    if (surveyData.geoFencing === 'Yes' && surveyData.geoTagging !== 'Yes') {
      errors.push({
        field: 'geoTagging',
        message: 'Geo Tagging must be "Yes" when Geo Fencing is "Yes"',
        value: surveyData.geoTagging
      });
    }

    // Date comparison: Close Date >= Launch Date
    if (surveyData.launchDate && surveyData.closeDate) {
      if (this._isValidDateFormat(surveyData.launchDate) && 
          this._isValidDateFormat(surveyData.closeDate)) {
        const launchDate = this._parseDateString(surveyData.launchDate);
        const closeDate = this._parseDateString(surveyData.closeDate);
        if (closeDate < launchDate) {
          errors.push({
            field: 'closeDate',
            message: 'Close Date must be greater than or equal to Launch Date',
            value: surveyData.closeDate
          });
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate a single question record
   */
  validateQuestion(questionData, surveys = [], allQuestions = []) {
    const errors = [];

    // Basic field validations
    for (const [field, rule] of Object.entries(this.questionValidationRules)) {
      const value = questionData[field];
      const fieldErrors = this._validateField(field, value, rule, questionData);
      errors.push(...fieldErrors);
    }

    // Cross-validation: Survey ID must exist
    if (questionData.surveyId && surveys.length > 0) {
      const surveyExists = surveys.some(s => s.surveyId === questionData.surveyId);
      if (!surveyExists) {
        errors.push({
          field: 'surveyId',
          message: 'Survey ID does not exist',
          value: questionData.surveyId
        });
      } else {
        // Validate medium matches survey's available mediums
        const survey = surveys.find(s => s.surveyId === questionData.surveyId);
        if (survey && questionData.medium) {
          const { values: surveyMediums } = this._parseMediumList(survey.availableMediums);
          
          if (!surveyMediums.includes(questionData.medium)) {
            errors.push({
              field: 'medium',
              message: `Medium must match survey's available mediums: ${surveyMediums.join(', ')}`,
              value: questionData.medium
            });
          }
        }
      }
    }

    // Child question validation
    if (questionData.questionId && questionData.questionId.includes('.')) {
      if (!questionData.sourceQuestion) {
        errors.push({
          field: 'sourceQuestion',
          message: 'Child questions must have a Source Question',
          value: questionData.sourceQuestion || ''
        });
      } else if (allQuestions.length > 0) {
        // Validate parent question exists
        const parentExists = allQuestions.some(q => 
          this._normalizeQuestionId(q.questionId) === this._normalizeQuestionId(questionData.sourceQuestion) && 
          q.surveyId === questionData.surveyId
        );
        if (!parentExists) {
          errors.push({
            field: 'sourceQuestion',
            message: 'Source Question (parent) does not exist',
            value: questionData.sourceQuestion
          });
        }
      }
    }

    const parentTypeErrors = this._validateChildParentType(questionData, allQuestions);
    errors.push(...parentTypeErrors);

    const childMappingErrors = this._validateChildMappings(questionData, allQuestions);
    errors.push(...childMappingErrors);

    // Question type specific validations
    const questionType = questionData.questionType;
    if (questionType) {
      const typeErrors = this._validateQuestionType(questionData, questionType);
      errors.push(...typeErrors);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate bulk data (array of records)
   */
  validateBulkSurveys(surveys) {
    const results = [];
    
    surveys.forEach((survey, index) => {
      const validation = this.validateSurvey(survey);
      if (!validation.isValid) {
        validation.errors.forEach(error => {
          results.push({
            row: index + 2, // +2 for header row and 0-index
            sheet: 'SurveyMaster',
            field: error.field,
            message: error.message,
            value: error.value || ''
          });
        });
      }
    });

    return results;
  }

  /**
   * Validate bulk questions
   */
  validateBulkQuestions(questions, surveys = []) {
    const results = [];
    
    questions.forEach((question, index) => {
      const validation = this.validateQuestion(question, surveys, questions);
      if (!validation.isValid) {
        validation.errors.forEach(error => {
          results.push({
            row: index + 2, // +2 for header row and 0-index
            sheet: 'QuestionMaster',
            field: error.field,
            message: error.message,
            value: error.value || ''
          });
        });
      }
    });

    return results;
  }

  /**
   * Validate a single field based on rules
   */
  _validateField(field, value, rule, data) {
    const errors = [];

    // Required validation
    if (rule.type === 'required' || rule.type === 'required') {
      if (value === undefined || value === null || value === '') {
        errors.push({
          field,
          message: `${field} is required`,
          value: value || ''
        });
        return errors; // Don't continue if required field is missing
      }
    }

    // Skip further validation if value is empty and not required
    if (!value && rule.type !== 'required') {
      return errors;
    }

    // Pattern validation
    if (rule.pattern && value) {
      if (!rule.pattern.test(value)) {
        errors.push({
          field,
          message: rule.message,
          value
        });
      }
    }

    // Max length validation
    if (rule.maxLength && value && value.length > rule.maxLength) {
      errors.push({
        field,
        message: `${field} must not exceed ${rule.maxLength} characters`,
        value
      });
    }

    // Enum validation
    if (rule.enum && value) {
      const values = Array.isArray(value) 
        ? value 
        : typeof value === 'string' 
          ? value.split(',').map(v => v.trim()) 
          : [value];
      
      for (const val of values) {
        if (!rule.enum.includes(val)) {
          errors.push({
            field,
            message: rule.message,
            value: val
          });
        }
      }
    }

    // Simple enum values (not array)
    if (rule.values && value && !rule.values.includes(value)) {
      errors.push({
        field,
        message: rule.message,
        value
      });
    }

    // Date format validation
    if (rule.type === 'dateFormat' && value) {
      if (!this._isValidDateFormat(value)) {
        errors.push({
          field,
          message: rule.message,
          value
        });
      }
    }

    // Custom validators
    if (rule.custom === 'hierarchicalAccessLevel' && value) {
      const levelErrors = this._validateHierarchyLevel(value);
      if (levelErrors) {
        errors.push({
          field,
          message: levelErrors,
          value
        });
      }
    }

    if (rule.custom === 'availableMediums') {
      const parseResult = this._parseMediumList(value);
      parseResult.errors.forEach((message) => {
        errors.push({
          field,
          message,
          value
        });
      });

      parseResult.values.forEach((medium) => {
        if (!AVAILABLE_MEDIUMS.includes(medium)) {
          errors.push({
            field,
            message: rule.message,
            value: medium
          });
        }
      });
    }

    return errors;
  }

  /**
   * Validate question type specific rules
   */
  _validateQuestionType(questionData, questionType) {
    const errors = [];

    // Questions requiring options
    const requiresOptions = [
      'Multiple Choice Single Select',
      'Multiple Choice Multi Select',
      'Drop Down',
      'Likert Scale',
      'Tabular Drop Down'
    ];

    if (requiresOptions.includes(questionType)) {
      if (!questionData.options || questionData.options.length === 0) {
        errors.push({
          field: 'options',
          message: `${questionType} requires at least one option`,
          value: ''
        });
      } else {
        // Max 20 options
        if (questionData.options.length > 20) {
          errors.push({
            field: 'options',
            message: 'Maximum 20 options allowed',
            value: questionData.options.length
          });
        }
        // Each option max 100 chars
        questionData.options.forEach((opt, idx) => {
          if (opt && opt.length > 100) {
            errors.push({
              field: 'options',
              message: `Option ${idx + 1} exceeds 100 characters`,
              value: opt
            });
          }
        });
      }
    }

    // Tabular questions
    const tabularTypes = ['Tabular Text Input', 'Tabular Drop Down', 'Tabular Check Box'];
    if (tabularTypes.includes(questionType)) {
      if (!questionData.tableHeaderValue) {
        errors.push({
          field: 'tableHeaderValue',
          message: 'Table Header Value is required for tabular questions',
          value: ''
        });
      } else {
        // Must be exactly 2 comma-separated values
        const headers = questionData.tableHeaderValue.split(',');
        if (headers.length !== 2) {
          errors.push({
            field: 'tableHeaderValue',
            message: 'Table Header Value must be exactly 2 comma-separated values',
            value: questionData.tableHeaderValue
          });
        }
      }

      if (!questionData.tableQuestionValue) {
        errors.push({
          field: 'tableQuestionValue',
          message: 'Table Question Value is required for tabular questions',
          value: ''
        });
      } else {
        // Validate format: a:Question1\nb:Question2
        const formatRegex = /^[a-z]:.+(\n[a-z]:.+)*$/;
        if (!formatRegex.test(questionData.tableQuestionValue)) {
          errors.push({
            field: 'tableQuestionValue',
            message: 'Table Question Value must be in format: a:Question 1\\nb:Question 2',
            value: questionData.tableQuestionValue
          });
        }
      }
    }

    // Question media link validation
    if (questionData.questionMediaType && questionData.questionMediaType !== 'None') {
      if (!questionData.questionMediaLink) {
        errors.push({
          field: 'questionMediaLink',
          message: 'Question Media Link is required when Question Media Type is not "None"',
          value: ''
        });
      } else if (questionData.questionMediaType === 'Video') {
        // Validate YouTube URL
        const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
        if (!youtubeRegex.test(questionData.questionMediaLink)) {
          errors.push({
            field: 'questionMediaLink',
            message: 'Video must be a valid YouTube URL',
            value: questionData.questionMediaLink
          });
        }
      }
    }

    return errors;
  }

  _normalizeQuestionId(value) {
    if (value === undefined || value === null) {
      return '';
    }
    const trimmed = String(value).trim();
    if (!trimmed) {
      return '';
    }
    if (/^q/i.test(trimmed)) {
      return `Q${trimmed.slice(1)}`;
    }
    if (/^\d+(\.\d+)*$/.test(trimmed)) {
      return `Q${trimmed}`;
    }
    return trimmed;
  }

  _parseMediumList(value) {
    let rawValues = [];
    const errors = [];
    let hasEmptyValue = false;

    if (Array.isArray(value)) {
      rawValues = value;
    } else if (typeof value === 'string') {
      rawValues = value.split(',');
    } else if (value !== undefined && value !== null) {
      rawValues = [value];
    }

    const values = [];
    rawValues.forEach((medium) => {
      const normalized = String(medium || '').trim();
      if (!normalized) {
        hasEmptyValue = true;
        return;
      }
      values.push(normalized);
    });

    if (hasEmptyValue) {
      errors.push('Available Mediums must not contain empty values');
    }

    if (values.length === 0) {
      errors.push('Available Mediums must include at least one medium');
    }

    return { values, errors };
  }

  _parseChildList(value) {
    if (!value) {
      return [];
    }
    return value
      .split(',')
      .map(part => this._normalizeQuestionId(part))
      .filter(Boolean);
  }

  _getOptionsForQuestion(question) {
    if (Array.isArray(question.options) && question.options.length > 0) {
      return question.options;
    }
    if (question.translations && typeof question.translations === 'object') {
      const languageKey = Object.keys(question.translations)[0];
      const options = question.translations[languageKey]?.options;
      if (Array.isArray(options)) {
        return options;
      }
    }
    return [];
  }

  _validateChildParentType(questionData, allQuestions) {
    const errors = [];
    const parentId = this._normalizeQuestionId(questionData.sourceQuestion);
    if (!parentId) {
      return errors;
    }
    const parent = allQuestions.find(q =>
      this._normalizeQuestionId(q.questionId) === parentId &&
      q.surveyId === questionData.surveyId
    );
    if (parent && parent.questionType !== 'Multiple Choice Single Select') {
      errors.push({
        field: 'sourceQuestion',
        message: 'Only Multiple Choice Single Select questions can have child questions. Change the Question ID or parent.',
        value: questionData.sourceQuestion
      });
    }
    return errors;
  }

  _validateChildMappings(questionData, allQuestions) {
    const errors = [];
    if (!questionData.surveyId) {
      return errors;
    }
    const normalizedQuestionId = this._normalizeQuestionId(questionData.questionId);
    const questions = allQuestions
      .filter(q => q.surveyId === questionData.surveyId)
      .filter(q => this._normalizeQuestionId(q.questionId) !== normalizedQuestionId);
    questions.push(questionData);

    const seen = new Map();
    const conflicts = new Set();

    questions.forEach(question => {
      const options = this._getOptionsForQuestion(question);
      options.forEach((option, optionIndex) => {
        const children = this._parseChildList(option?.children || '');
        const uniqueChildren = new Set(children);
        uniqueChildren.forEach(childId => {
          const existing = seen.get(childId);
          const normalizedQuestionId = this._normalizeQuestionId(question.questionId);
          if (existing && (existing.questionId !== normalizedQuestionId || existing.optionIndex !== optionIndex)) {
            conflicts.add(childId);
          } else {
            seen.set(childId, { questionId: normalizedQuestionId, optionIndex });
          }
        });
      });
    });

    if (conflicts.size > 0) {
      errors.push({
        field: 'options',
        message: `Child question IDs cannot be mapped to multiple options/questions: ${Array.from(conflicts).join(', ')}`,
        value: ''
      });
    }

    return errors;
  }

  /**
   * Validate hierarchy level format
   */
  _validateHierarchyLevel(value) {
    if (!value) return null;

    const levels = value.split(',').map(l => l.trim()).filter(l => l);
    
    // Check all are numeric
    for (const level of levels) {
      if (!/^\d+$/.test(level)) {
        return 'Hierarchical Access Level must contain only numeric values';
      }
      const num = parseInt(level);
      if (num < 1 || num > 7) {
        return 'Hierarchical Access Level values must be between 1 and 7';
      }
    }

    // Check for duplicates
    const uniqueLevels = [...new Set(levels)];
    if (uniqueLevels.length !== levels.length) {
      return 'Hierarchical Access Level must not contain duplicate values';
    }

    return null;
  }

  /**
   * Validate date format DD/MM/YYYY HH:MM:SS or DD/MM/YYYY
   */
  _isValidDateFormat(dateString) {
    if (!dateString) return false;

    // Try DD/MM/YYYY HH:MM:SS format
    const regex1 = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/;
    // Try DD/MM/YYYY format
    const regex2 = /^\d{2}\/\d{2}\/\d{4}$/;
    
    if (!regex1.test(dateString) && !regex2.test(dateString)) {
      return false;
    }

    // Validate actual date values
    const datePart = dateString.split(' ')[0];
    const [day, month, year] = datePart.split('/').map(Number);
    
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    if (year < 1900) return false;

    // If time part exists, validate it
    if (dateString.includes(' ')) {
      const timePart = dateString.split(' ')[1];
      const [hours, minutes, seconds] = timePart.split(':').map(Number);
      if (hours < 0 || hours > 23) return false;
      if (minutes < 0 || minutes > 59) return false;
      if (seconds < 0 || seconds > 59) return false;
    }

    return true;
  }

  /**
   * Parse date string DD/MM/YYYY HH:MM:SS to Date object
   */
  _parseDateString(dateString) {
    const [datePart, timePart] = dateString.split(' ');
    const [day, month, year] = datePart.split('/').map(Number);
    
    if (timePart) {
      const [hours, minutes, seconds] = timePart.split(':').map(Number);
      return new Date(year, month - 1, day, hours, minutes, seconds);
    } else {
      return new Date(year, month - 1, day);
    }
  }

  /**
   * Get validation schema (for API endpoint)
   */
  getValidationSchema() {
    return {
      survey: this.surveyValidationRules,
      question: this.questionValidationRules,
      constants: {
        availableMediums: AVAILABLE_MEDIUMS,
        questionTypes: QUESTION_TYPES,
        textInputTypes: TEXT_INPUT_TYPES,
        questionMediaTypes: QUESTION_MEDIA_TYPES,
        modes: MODES,
        yesNoValues: YES_NO_VALUES
      }
    };
  }
}

// Export singleton instance
module.exports = new ValidationEngine();
