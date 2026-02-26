const express = require('express');
const router = express.Router();
const validator = require('../services/validator');
const store = require('../data/store');

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
    const surveys = await store.getAllSurveys();
    res.json(surveys);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch surveys', message: error.message });
  }
});

// GET /api/surveys/:id - Get survey by ID
router.get('/:id', async (req, res) => {
  try {
    const survey = await store.getSurveyById(req.params.id);
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
    
    if (!surveyData.surveyId || surveyData.surveyId.trim() === '') {
      return res.status(400).json({ error: 'Survey ID is required', errors: ['Survey ID is required'] });
    }
    if (!surveyData.surveyName || surveyData.surveyName.trim() === '') {
      return res.status(400).json({ error: 'Survey Name is required', errors: ['Survey Name is required'] });
    }
    if (!surveyData.surveyDescription || surveyData.surveyDescription.trim() === '') {
      return res.status(400).json({ error: 'Survey Description is required', errors: ['Survey Description is required'] });
    }
    
    const validation = validator.validateSurvey(surveyData);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }
    
    if (await store.surveyExists(surveyData.surveyId)) {
      return res.status(400).json({
        error: 'Survey ID already exists',
        errors: [`Survey ID "${surveyData.surveyId}" already exists. Please use a unique Survey ID.`]
      });
    }
    
    await store.createSurvey(surveyData);
    res.status(201).json(surveyData);
  } catch (error) {
    console.error('Survey creation error:', error);
    res.status(500).json({ error: 'Failed to create survey', errors: [error.message || 'Internal server error'], message: error.message });
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
        details: [{ field: 'surveyId', expected: req.params.id, received: surveyData.surveyId || '' }],
        errors: ['Payload surveyId must match the survey ID in the URL path']
      });
    }
    
    const validation = validator.validateSurvey(surveyData);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }
    
    const updated = await store.updateSurvey(req.params.id, surveyData);
    if (!updated) {
      return res.status(404).json({ error: 'Survey not found', errors: ['Survey not found'] });
    }
    
    res.json(surveyData);
  } catch (error) {
    console.error('Survey update error:', error);
    res.status(500).json({ error: 'Failed to update survey', errors: [error.message || 'Internal server error'], message: error.message });
  }
});

// DELETE /api/surveys/:id - Delete survey
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await store.deleteSurvey(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    res.json({ message: 'Survey deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete survey', message: error.message });
  }
});

// GET /api/surveys/:id/questions - Get questions for a survey
router.get('/:id/questions', async (req, res) => {
  try {
    const questions = await store.getQuestionsBySurvey(req.params.id);
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch questions', message: error.message });
  }
});

// POST /api/surveys/:id/questions - Add question to survey
router.post('/:id/questions', async (req, res) => {
  try {
    const questionData = { ...req.body, surveyId: req.params.id };
    
    const survey = await store.getSurveyById(req.params.id);
    if (!survey) {
      return res.status(404).json({ error: 'Survey not found', errors: [`Survey with ID "${req.params.id}" not found`] });
    }
    
    if (!questionData.questionId || questionData.questionId.trim() === '') {
      return res.status(400).json({ error: 'Question ID is required', errors: ['Question ID is required'] });
    }
    if (!questionData.questionType || questionData.questionType === '') {
      return res.status(400).json({ error: 'Question Type is required', errors: ['Question Type is required'] });
    }
    
    const allSurveys = await store.getAllSurveys();
    const allQuestions = await store.getAllQuestions();
    
    const validation = validator.validateQuestion(questionData, allSurveys, allQuestions);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }
    
    if (await store.questionExists(req.params.id, questionData.questionId)) {
      return res.status(400).json({
        error: 'Question ID already exists',
        errors: [`Question ID "${questionData.questionId}" already exists for this survey. Please use a unique Question ID.`]
      });
    }
    
    await store.createQuestion(questionData);
    res.status(201).json(questionData);
  } catch (error) {
    console.error('Question creation error:', error);
    res.status(500).json({ error: 'Failed to create question', errors: [error.message || 'Internal server error'], message: error.message });
  }
});

// PUT /api/surveys/:id/questions/:questionId - Update question
router.put('/:id/questions/:questionId', async (req, res) => {
  try {
    const questionData = { ...req.body, surveyId: req.params.id, questionId: req.params.questionId };
    
    const allSurveys = await store.getAllSurveys();
    const allQuestions = await store.getAllQuestions();
    
    const validation = validator.validateQuestion(questionData, allSurveys, allQuestions);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
    }
    
    const updated = await store.updateQuestion(req.params.id, req.params.questionId, questionData);
    if (!updated) {
      return res.status(404).json({ error: 'Question not found', errors: ['Question not found'] });
    }
    
    res.json(questionData);
  } catch (error) {
    console.error('Question update error:', error);
    res.status(500).json({ error: 'Failed to update question', errors: [error.message || 'Internal server error'], message: error.message });
  }
});

// DELETE /api/surveys/:id/questions/:questionId - Delete question
router.delete('/:id/questions/:questionId', async (req, res) => {
  try {
    const deleted = await store.deleteQuestion(req.params.id, req.params.questionId);
    if (!deleted) {
      return res.status(404).json({ error: 'Question not found' });
    }
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
    
    const originalSurvey = await store.getSurveyById(req.params.id);
    if (!originalSurvey) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    if (await store.surveyExists(newSurveyId)) {
      return res.status(400).json({ error: 'Survey ID already exists' });
    }
    
    const duplicatedSurvey = { ...originalSurvey, surveyId: newSurveyId, launchDate: '', closeDate: '' };
    
    const validation = validator.validateSurvey(duplicatedSurvey);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }
    
    const originalQuestions = await store.getQuestionsBySurvey(req.params.id);
    const duplicatedQuestions = originalQuestions.map(q => ({ ...q, surveyId: newSurveyId }));
    
    await store.bulkImport([duplicatedSurvey], duplicatedQuestions);
    
    res.status(201).json({ survey: duplicatedSurvey, questionsCount: duplicatedQuestions.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to duplicate survey', message: error.message });
  }
});

// POST /api/surveys/:surveyId/questions/:questionId/duplicate - Duplicate question
router.post('/:surveyId/questions/:questionId/duplicate', async (req, res) => {
  try {
    const { surveyId, questionId } = req.params;
    const requestedQuestionId = normalizeQuestionId(req.body?.newQuestionId);
    
    const originalQuestion = await store.getQuestionById(surveyId, questionId);
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
      const surveyQuestions = await store.getQuestionsBySurvey(surveyId);
      const questionNumbers = surveyQuestions
        .map(q => {
          const match = q.questionId.match(/^Q(\d+)(?:\.(\d+))?$/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter(n => n > 0);

      const maxQuestionNum = questionNumbers.length > 0
        ? questionNumbers.reduce((max, num) => Math.max(max, num), 0)
        : 0;
      newQuestionId = `Q${maxQuestionNum + 1}`;
    }
    
    const duplicatedQuestion = {
      ...originalQuestion,
      questionId: newQuestionId,
      sourceQuestion: '',
      optionChildren: originalQuestion.optionChildren || ''
    };
    
    if (await store.questionExists(surveyId, newQuestionId)) {
      return res.status(400).json({
        error: 'Question ID already exists',
        message: `Question ID "${newQuestionId}" already exists for this survey`,
        details: [{ field: 'newQuestionId', value: newQuestionId }]
      });
    }
    
    const allSurveys = await store.getAllSurveys();
    const allQuestions = await store.getAllQuestions();
    const validation = validator.validateQuestion(duplicatedQuestion, allSurveys, allQuestions);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }
    
    await store.createQuestion(duplicatedQuestion);
    res.status(201).json(duplicatedQuestion);
  } catch (error) {
    res.status(500).json({ error: 'Failed to duplicate question', message: error.message });
  }
});

module.exports = router;
