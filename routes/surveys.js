const express = require('express');
const router = express.Router();
const validator = require('../services/validator');
const { readStore, writeStore } = require('../data/store');

function normalizeQuestionId(value) {
  const trimmed = String(value || '').trim();
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

// GET /api/surveys - List all surveys
router.get('/', async (req, res) => {
  try {
    const store = await readStore();
    res.json(store.surveys);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch surveys', message: error.message });
  }
});

// GET /api/surveys/:id - Get survey by ID
router.get('/:id', async (req, res) => {
  try {
    const store = await readStore();
    const survey = store.surveys.find(s => s.surveyId === req.params.id);
    
    if (!survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    res.json(survey);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch survey', message: error.message });
  }
});

// POST /api/surveys - Create new survey
router.post('/', async (req, res) => {
  try {
    const surveyData = req.body;
    
    // Validate required fields first
    if (!surveyData.surveyId || surveyData.surveyId.trim() === '') {
      return res.status(400).json({ 
        error: 'Survey ID is required',
        errors: ['Survey ID is required'] 
      });
    }
    
    if (!surveyData.surveyName || surveyData.surveyName.trim() === '') {
      return res.status(400).json({ 
        error: 'Survey Name is required',
        errors: ['Survey Name is required'] 
      });
    }
    
    if (!surveyData.surveyDescription || surveyData.surveyDescription.trim() === '') {
      return res.status(400).json({ 
        error: 'Survey Description is required',
        errors: ['Survey Description is required'] 
      });
    }
    
    // Validate survey data
    const validation = validator.validateSurvey(surveyData);
    if (!validation.isValid) {
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: validation.errors 
      });
    }
    
    const store = await readStore();
    
    // Check if survey ID already exists
    if (store.surveys.find(s => s.surveyId === surveyData.surveyId)) {
      return res.status(400).json({ 
        error: 'Survey ID already exists',
        errors: [`Survey ID "${surveyData.surveyId}" already exists. Please use a unique Survey ID.`] 
      });
    }
    
    // Add survey
    store.surveys.push(surveyData);
    await writeStore(store);
    
    res.status(201).json(surveyData);
  } catch (error) {
    console.error('Survey creation error:', error);
    res.status(500).json({ 
      error: 'Failed to create survey', 
      errors: [error.message || 'Internal server error'],
      message: error.message 
    });
  }
});

// PUT /api/surveys/:id - Update survey
router.put('/:id', async (req, res) => {
  try {
    const surveyData = req.body;

    if (surveyData.surveyId !== req.params.id) {
      return res.status(400).json({
        error: 'Survey ID mismatch',
        message: 'Payload surveyId must match the survey ID in the URL path',
        details: [
          {
            field: 'surveyId',
            expected: req.params.id,
            received: surveyData.surveyId || ''
          }
        ],
        errors: ['Payload surveyId must match the survey ID in the URL path']
      });
    }
    
    // Validate survey data
    const validation = validator.validateSurvey(surveyData);
    if (!validation.isValid) {
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: validation.errors 
      });
    }
    
    const store = await readStore();
    const index = store.surveys.findIndex(s => s.surveyId === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ 
        error: 'Survey not found',
        errors: ['Survey not found'] 
      });
    }
    
    store.surveys[index] = surveyData;
    await writeStore(store);
    
    res.json(surveyData);
  } catch (error) {
    console.error('Survey update error:', error);
    res.status(500).json({ 
      error: 'Failed to update survey', 
      errors: [error.message || 'Internal server error'],
      message: error.message 
    });
  }
});

// DELETE /api/surveys/:id - Delete survey
router.delete('/:id', async (req, res) => {
  try {
    const store = await readStore();
    const index = store.surveys.findIndex(s => s.surveyId === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    // Remove survey
    store.surveys.splice(index, 1);
    
    // Remove associated questions
    store.questions = store.questions.filter(q => q.surveyId !== req.params.id);
    
    await writeStore(store);
    
    res.json({ message: 'Survey deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete survey', message: error.message });
  }
});

// GET /api/surveys/:id/questions - Get questions for a survey
router.get('/:id/questions', async (req, res) => {
  try {
    const store = await readStore();
    const questions = store.questions.filter(q => q.surveyId === req.params.id);
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch questions', message: error.message });
  }
});

// POST /api/surveys/:id/questions - Add question to survey
router.post('/:id/questions', async (req, res) => {
  try {
    const questionData = { ...req.body, surveyId: req.params.id };
    
    const store = await readStore();
    
    // Check if survey exists
    const survey = store.surveys.find(s => s.surveyId === req.params.id);
    if (!survey) {
      return res.status(404).json({ 
        error: 'Survey not found',
        errors: [`Survey with ID "${req.params.id}" not found`] 
      });
    }
    
    // Validate required fields first
    if (!questionData.questionId || questionData.questionId.trim() === '') {
      return res.status(400).json({ 
        error: 'Question ID is required',
        errors: ['Question ID is required'] 
      });
    }
    
    if (!questionData.questionType || questionData.questionType === '') {
      return res.status(400).json({ 
        error: 'Question Type is required',
        errors: ['Question Type is required'] 
      });
    }
    
    // Validate question data
    const validation = validator.validateQuestion(questionData, store.surveys, store.questions);
    if (!validation.isValid) {
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: validation.errors 
      });
    }
    
    // Check if question ID already exists for this survey
    if (store.questions.find(q => q.surveyId === req.params.id && q.questionId === questionData.questionId)) {
      return res.status(400).json({ 
        error: 'Question ID already exists',
        errors: [`Question ID "${questionData.questionId}" already exists for this survey. Please use a unique Question ID.`] 
      });
    }
    
    // Add question
    store.questions.push(questionData);
    await writeStore(store);
    
    res.status(201).json(questionData);
  } catch (error) {
    console.error('Question creation error:', error);
    res.status(500).json({ 
      error: 'Failed to create question', 
      errors: [error.message || 'Internal server error'],
      message: error.message 
    });
  }
});

// PUT /api/surveys/:id/questions/:questionId - Update question
router.put('/:id/questions/:questionId', async (req, res) => {
  try {
    const questionData = { ...req.body, surveyId: req.params.id, questionId: req.params.questionId };
    
    // Validate question data
    const store = await readStore();
    const validation = validator.validateQuestion(questionData, store.surveys, store.questions);
    if (!validation.isValid) {
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: validation.errors 
      });
    }
    
    const index = store.questions.findIndex(
      q => q.surveyId === req.params.id && q.questionId === req.params.questionId
    );
    
    if (index === -1) {
      return res.status(404).json({ 
        error: 'Question not found',
        errors: ['Question not found'] 
      });
    }
    
    store.questions[index] = questionData;
    await writeStore(store);
    
    res.json(questionData);
  } catch (error) {
    console.error('Question update error:', error);
    res.status(500).json({ 
      error: 'Failed to update question', 
      errors: [error.message || 'Internal server error'],
      message: error.message 
    });
  }
});

// DELETE /api/surveys/:id/questions/:questionId - Delete question
router.delete('/:id/questions/:questionId', async (req, res) => {
  try {
    const store = await readStore();
    const index = store.questions.findIndex(
      q => q.surveyId === req.params.id && q.questionId === req.params.questionId
    );
    
    if (index === -1) {
      return res.status(404).json({ error: 'Question not found' });
    }
    
    store.questions.splice(index, 1);
    await writeStore(store);
    
    res.json({ message: 'Question deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete question', message: error.message });
  }
});

// POST /api/surveys/:id/duplicate - Duplicate survey
router.post('/:id/duplicate', async (req, res) => {
  try {
    const { newSurveyId } = req.body;
    
    if (!newSurveyId) {
      return res.status(400).json({ error: 'New Survey ID is required' });
    }
    
    const store = await readStore();
    
    // Find original survey
    const originalSurvey = store.surveys.find(s => s.surveyId === req.params.id);
    if (!originalSurvey) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    // Check if new survey ID already exists
    if (store.surveys.find(s => s.surveyId === newSurveyId)) {
      return res.status(400).json({ error: 'Survey ID already exists' });
    }
    
    // Create duplicated survey (reset dates)
    const duplicatedSurvey = {
      ...originalSurvey,
      surveyId: newSurveyId,
      launchDate: '',
      closeDate: ''
    };
    
    // Validate duplicated survey
    const validation = validator.validateSurvey(duplicatedSurvey);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }
    
    // Get all questions for original survey
    const originalQuestions = store.questions.filter(q => q.surveyId === req.params.id);
    
    // Duplicate all questions
    const duplicatedQuestions = originalQuestions.map(q => ({
      ...q,
      surveyId: newSurveyId
    }));
    
    // Add to store
    store.surveys.push(duplicatedSurvey);
    store.questions.push(...duplicatedQuestions);
    await writeStore(store);
    
    res.status(201).json({
      survey: duplicatedSurvey,
      questionsCount: duplicatedQuestions.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to duplicate survey', message: error.message });
  }
});

// POST /api/surveys/:surveyId/questions/:questionId/duplicate - Duplicate question
router.post('/:surveyId/questions/:questionId/duplicate', async (req, res) => {
  try {
    const { surveyId, questionId } = req.params;
    const requestedQuestionId = normalizeQuestionId(req.body?.newQuestionId);
    
    const store = await readStore();
    
    // Find original question
    const originalQuestion = store.questions.find(
      q => q.surveyId === surveyId && q.questionId === questionId
    );
    
    if (!originalQuestion) {
      return res.status(404).json({ error: 'Question not found' });
    }
    
    let newQuestionId = requestedQuestionId;

    if (newQuestionId) {
      if (!/^Q\d+(\.\d+)*$/.test(newQuestionId)) {
        return res.status(400).json({
          error: 'Invalid Question ID format',
          message: 'newQuestionId must be in format Q1, Q1.1, Q2, etc.',
          details: [{ field: 'newQuestionId', value: requestedQuestionId }]
        });
      }
    } else {
      // Generate new question ID when not explicitly provided
      const surveyQuestions = store.questions.filter(q => q.surveyId === surveyId);
      const questionNumbers = surveyQuestions
        .map(q => {
          const match = q.questionId.match(/^Q(\d+)(?:\.(\d+))?$/);
          if (match) {
            return parseInt(match[1], 10);
          }
          return 0;
        })
        .filter(n => n > 0);

      const maxQuestionNum = questionNumbers.length > 0
        ? questionNumbers.reduce((max, num) => Math.max(max, num), 0)
        : 0;
      newQuestionId = `Q${maxQuestionNum + 1}`;
    }
    
    // Create duplicated question
    const duplicatedQuestion = {
      ...originalQuestion,
      questionId: newQuestionId,
      sourceQuestion: '', // Reset source question for duplicated question
      optionChildren: originalQuestion.optionChildren || ''
    };
    
    // Check if new question ID already exists
    if (store.questions.find(q => q.surveyId === surveyId && q.questionId === newQuestionId)) {
      return res.status(400).json({
        error: 'Question ID already exists',
        message: `Question ID "${newQuestionId}" already exists for this survey`,
        details: [{ field: 'newQuestionId', value: newQuestionId }]
      });
    }
    
    // Validate duplicated question
    const validation = validator.validateQuestion(duplicatedQuestion, store.surveys, store.questions);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }
    
    // Add to store
    store.questions.push(duplicatedQuestion);
    await writeStore(store);
    
    res.status(201).json(duplicatedQuestion);
  } catch (error) {
    res.status(500).json({ error: 'Failed to duplicate question', message: error.message });
  }
});

module.exports = router;
