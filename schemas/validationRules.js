// Validation rules based on CSV specifications

const questionTypes = [
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

const textInputTypes = ['Numeric', 'Alphanumeric', 'Alphabets', 'None'];
const questionMediaTypes = ['Image', 'Video', 'Audio', 'None'];
const modes = ['New Data', 'Correction', 'Delete Data', 'None'];
const yesNoValues = ['Yes', 'No'];

// Validation rules for different question types
const validationRules = {
  'Tabular Text Input': {
    required: ['tableHeaderValue', 'tableQuestionValue'],
    optional: ['textInputType', 'maxValue', 'minValue'],
    constraints: {
      tableQuestionValue: {
        format: /^[a-z]:.+(\n[a-z]:.+)*$/,
        maxQuestions: 20,
        maxCharsPerQuestion: 100
      }
    }
  },
  'Tabular Drop Down': {
    required: ['tableHeaderValue', 'tableQuestionValue', 'options'],
    optional: [],
    constraints: {
      textInputType: 'None',
      tableQuestionValue: {
        format: /^[a-z]:.+(\n[a-z]:.+)*$/,
        maxQuestions: 20,
        maxCharsPerQuestion: 100
      },
      maxOptions: 20
    }
  },
  'Tabular Check Box': {
    required: ['tableHeaderValue', 'tableQuestionValue'],
    optional: [],
    constraints: {
      tableQuestionValue: {
        format: /^[a-z]:.+(\n[a-z]:.+)*$/,
        maxQuestions: 20,
        maxCharsPerQuestion: 100
      }
    }
  },
  'Multiple Choice Single Select': {
    required: ['options'],
    optional: ['optionChildren'],
    constraints: {
      textInputType: 'None',
      questionMediaType: 'None',
      maxOptions: 20,
      minOptions: 2
    }
  },
  'Multiple Choice Multi Select': {
    required: ['options'],
    optional: ['optionChildren'],
    constraints: {
      textInputType: 'None',
      questionMediaType: 'None',
      maxOptions: 20,
      minOptions: 2
    }
  },
  'Text Response': {
    required: [],
    optional: ['textInputType', 'maxValue', 'minValue', 'textLimitCharacters'],
    constraints: {
      defaultCharLimit: 1024
    }
  },
  'Image Upload': {
    required: [],
    optional: [],
    constraints: {
      maxSize: 6 * 1024 * 1024 // 6 MB
    }
  },
  'Video Upload': {
    required: [],
    optional: [],
    constraints: {
      maxSize: 10 * 1024 * 1024 // 10 MB
    }
  },
  'Voice Response': {
    required: [],
    optional: [],
    constraints: {}
  },
  'Likert Scale': {
    required: ['options'],
    optional: [],
    constraints: {
      maxOptions: 20
    }
  },
  'Calendar': {
    required: [],
    optional: [],
    constraints: {}
  },
  'Drop Down': {
    required: ['options'],
    optional: [],
    constraints: {
      maxOptions: 20
    }
  }
};

// Parent-child question validation
const childQuestionRules = {
  formatRegex: /^Q\d+\.\d+$/,  // Format: Q1.1, Q1.2, etc.
  requiresSourceQuestion: true
};

module.exports = {
  questionTypes,
  textInputTypes,
  questionMediaTypes,
  modes,
  yesNoValues,
  validationRules,
  childQuestionRules
};
