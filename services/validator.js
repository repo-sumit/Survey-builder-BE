const {
  questionTypes,
  textInputTypes,
  questionMediaTypes,
  modes,
  yesNoValues,
  validationRules,
  childQuestionRules
} = require('../schemas/validationRules');

const validationEngine = require('../validation/validationEngine');

class Validator {
  // Validate survey data
  validateSurvey(surveyData) {
    // Use the comprehensive validation engine
    const validation = validationEngine.validateSurvey(surveyData);
    
    // Convert error format to match existing API
    const errors = validation.errors.map(err => err.message);
    
    return {
      isValid: validation.isValid,
      errors
    };
  }

  // Validate question data
  validateQuestion(questionData, surveys = [], existingQuestions = []) {
    // Use the comprehensive validation engine
    const validation = validationEngine.validateQuestion(questionData, surveys, existingQuestions);
    
    // Convert error format to match existing API
    const errors = validation.errors.map(err => err.message);
    
    return {
      isValid: validation.isValid,
      errors
    };
  }

  // Validate date format DD/MM/YYYY HH:MM:SS
  isValidDate(dateString) {
    const regex = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/;
    if (!regex.test(dateString)) {
      return false;
    }
    
    const [datePart, timePart] = dateString.split(' ');
    const [day, month, year] = datePart.split('/').map(Number);
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    
    // Basic validation
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    if (hours < 0 || hours > 23) return false;
    if (minutes < 0 || minutes > 59) return false;
    if (seconds < 0 || seconds > 59) return false;
    
    return true;
  }
}

module.exports = new Validator();
