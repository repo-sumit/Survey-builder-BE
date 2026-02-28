const express = require('express');
const router = express.Router();
const validator = require('../services/validator');
const { readStore, writeStore } = require('../data/store');
const { pool } = require('../data/db');
const { requireWriteAccess } = require('../middleware/auth');

// --- Helpers ---

function normalizeQuestionId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^q/i.test(trimmed)) return `Q${trimmed.slice(1)}`;
  if (/^\d+(\.\d+)*$/.test(trimmed)) return `Q${trimmed}`;
  return trimmed;
}

function verifySurveyAccess(survey, user) {
  if (user.role === 'admin') return true;
  if (!survey.stateCode) return false; // admin-only survey
  return survey.stateCode === user.stateCode;
}

function isPublishEnabled() {
  return process.env.FEATURE_PUBLISH === 'true';
}

function isPublished(survey) {
  return survey.publish && survey.publish.status === 'PUBLISHED';
}

// --- Lock helpers (direct SQL) ---

async function acquireLock(surveyId, userId) {
  // Clean expired locks
  await pool.query('DELETE FROM survey_locks WHERE expires_at < NOW()');

  const existing = await pool.query(
    'SELECT locked_by, expires_at FROM survey_locks WHERE survey_id = $1',
    [surveyId]
  );

  if (existing.rows.length > 0 && existing.rows[0].locked_by !== userId) {
    // Get locker's username
    const locker = await pool.query('SELECT username FROM users WHERE id = $1', [existing.rows[0].locked_by]);
    return {
      conflict: true,
      lockedBy: locker.rows[0]?.username || 'unknown',
      expiresAt: existing.rows[0].expires_at
    };
  }

  await pool.query(`
    INSERT INTO survey_locks (survey_id, locked_by, locked_at, expires_at)
    VALUES ($1, $2, NOW(), NOW() + INTERVAL '15 minutes')
    ON CONFLICT (survey_id) DO UPDATE SET
      locked_by = $2, locked_at = NOW(), expires_at = NOW() + INTERVAL '15 minutes'
  `, [surveyId, userId]);

  return { conflict: false };
}

async function releaseLock(surveyId, userId, isAdmin) {
  if (isAdmin) {
    await pool.query('DELETE FROM survey_locks WHERE survey_id = $1', [surveyId]);
  } else {
    await pool.query('DELETE FROM survey_locks WHERE survey_id = $1 AND locked_by = $2', [surveyId, userId]);
  }
}

async function checkLock(surveyId, userId) {
  await pool.query('DELETE FROM survey_locks WHERE expires_at < NOW()');
  const result = await pool.query(
    'SELECT locked_by FROM survey_locks WHERE survey_id = $1',
    [surveyId]
  );
  if (result.rows.length > 0 && result.rows[0].locked_by !== userId) {
    const locker = await pool.query('SELECT username FROM users WHERE id = $1', [result.rows[0].locked_by]);
    return { locked: true, lockedBy: locker.rows[0]?.username || 'unknown' };
  }
  return { locked: false };
}

// ========== SURVEY ROUTES ==========

// GET /api/surveys - List all surveys
router.get('/', async (req, res) => {
  try {
    const store = await readStore();
    let surveys = store.surveys;

    // State scoping
    if (req.user.role !== 'admin') {
      surveys = surveys.filter(s => s.stateCode && s.stateCode === req.user.stateCode);
    }

    res.json(surveys);
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

    if (!verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(survey);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch survey', message: error.message });
  }
});

// POST /api/surveys - Create new survey
router.post('/', requireWriteAccess, async (req, res) => {
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

    // Auto-set stateCode for non-admin
    if (req.user.role !== 'admin') {
      surveyData.stateCode = req.user.stateCode;
    }

    // Default publish status
    if (!surveyData.publish) {
      surveyData.publish = { status: 'DRAFT' };
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
router.put('/:id', requireWriteAccess, async (req, res) => {
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

    if (!verifySurveyAccess(store.surveys[index], req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Lock check
    const lock = await checkLock(req.params.id, req.user.id);
    if (lock.locked) {
      return res.status(409).json({ error: `Survey is locked by ${lock.lockedBy}` });
    }

    // Preserve stateCode and publish from existing survey if not admin
    if (req.user.role !== 'admin') {
      surveyData.stateCode = store.surveys[index].stateCode;
    }
    if (!surveyData.publish) {
      surveyData.publish = store.surveys[index].publish || { status: 'DRAFT' };
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
router.delete('/:id', requireWriteAccess, async (req, res) => {
  try {
    const store = await readStore();
    const index = store.surveys.findIndex(s => s.surveyId === req.params.id);

    if (index === -1) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    if (!verifySurveyAccess(store.surveys[index], req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard
    if (isPublishEnabled() && isPublished(store.surveys[index])) {
      return res.status(403).json({ error: 'Cannot delete a published survey' });
    }

    store.surveys.splice(index, 1);
    store.questions = store.questions.filter(q => q.surveyId !== req.params.id);
    await writeStore(store);

    res.json({ message: 'Survey deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete survey', message: error.message });
  }
});

// ========== QUESTION ROUTES ==========

// GET /api/surveys/:id/questions - Get questions for a survey
router.get('/:id/questions', async (req, res) => {
  try {
    const store = await readStore();
    const survey = store.surveys.find(s => s.surveyId === req.params.id);

    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const questions = store.questions.filter(q => q.surveyId === req.params.id);
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch questions', message: error.message });
  }
});

// POST /api/surveys/:id/questions - Add question to survey
router.post('/:id/questions', requireWriteAccess, async (req, res) => {
  try {
    const questionData = { ...req.body, surveyId: req.params.id };

    const store = await readStore();

    const survey = store.surveys.find(s => s.surveyId === req.params.id);
    if (!survey) {
      return res.status(404).json({
        error: 'Survey not found',
        errors: [`Survey with ID "${req.params.id}" not found`]
      });
    }

    if (!verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard
    if (isPublishEnabled() && isPublished(survey)) {
      return res.status(403).json({ error: 'Cannot add questions to a published survey' });
    }

    // Lock check
    const lock = await checkLock(req.params.id, req.user.id);
    if (lock.locked) {
      return res.status(409).json({ error: `Survey is locked by ${lock.lockedBy}` });
    }

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

    const validation = validator.validateQuestion(questionData, store.surveys, store.questions);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Validation failed',
        errors: validation.errors
      });
    }

    if (store.questions.find(q => q.surveyId === req.params.id && q.questionId === questionData.questionId)) {
      return res.status(400).json({
        error: 'Question ID already exists',
        errors: [`Question ID "${questionData.questionId}" already exists for this survey. Please use a unique Question ID.`]
      });
    }

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
router.put('/:id/questions/:questionId', requireWriteAccess, async (req, res) => {
  try {
    const questionData = { ...req.body, surveyId: req.params.id, questionId: req.params.questionId };

    const store = await readStore();

    const survey = store.surveys.find(s => s.surveyId === req.params.id);
    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard: block questionType change on published survey
    if (isPublishEnabled() && survey && isPublished(survey)) {
      const existingQ = store.questions.find(
        q => q.surveyId === req.params.id && q.questionId === req.params.questionId
      );
      if (existingQ && questionData.questionType !== existingQ.questionType) {
        return res.status(403).json({ error: 'Cannot change question type on a published survey' });
      }
    }

    // Lock check
    const lock = await checkLock(req.params.id, req.user.id);
    if (lock.locked) {
      return res.status(409).json({ error: `Survey is locked by ${lock.lockedBy}` });
    }

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
router.delete('/:id/questions/:questionId', requireWriteAccess, async (req, res) => {
  try {
    const store = await readStore();

    const survey = store.surveys.find(s => s.surveyId === req.params.id);
    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard
    if (isPublishEnabled() && survey && isPublished(survey)) {
      return res.status(403).json({ error: 'Cannot delete questions from a published survey' });
    }

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

// ========== DUPLICATE ROUTES ==========

// POST /api/surveys/:id/duplicate - Duplicate survey
router.post('/:id/duplicate', requireWriteAccess, async (req, res) => {
  try {
    const { newSurveyId } = req.body;

    if (!newSurveyId) {
      return res.status(400).json({ error: 'New Survey ID is required' });
    }

    const store = await readStore();

    const originalSurvey = store.surveys.find(s => s.surveyId === req.params.id);
    if (!originalSurvey) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    if (!verifySurveyAccess(originalSurvey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (store.surveys.find(s => s.surveyId === newSurveyId)) {
      return res.status(400).json({ error: 'Survey ID already exists' });
    }

    const duplicatedSurvey = {
      ...originalSurvey,
      surveyId: newSurveyId,
      launchDate: '',
      closeDate: '',
      publish: { status: 'DRAFT' }
    };

    // Inherit stateCode for non-admin
    if (req.user.role !== 'admin') {
      duplicatedSurvey.stateCode = req.user.stateCode;
    }

    const validation = validator.validateSurvey(duplicatedSurvey);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }

    const originalQuestions = store.questions.filter(q => q.surveyId === req.params.id);
    const duplicatedQuestions = originalQuestions.map(q => ({
      ...q,
      surveyId: newSurveyId
    }));

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
router.post('/:surveyId/questions/:questionId/duplicate', requireWriteAccess, async (req, res) => {
  try {
    const { surveyId, questionId } = req.params;
    const requestedQuestionId = normalizeQuestionId(req.body?.newQuestionId);

    const store = await readStore();

    const survey = store.surveys.find(s => s.surveyId === surveyId);
    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard
    if (isPublishEnabled() && survey && isPublished(survey)) {
      return res.status(403).json({ error: 'Cannot duplicate questions on a published survey' });
    }

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
      const surveyQuestions = store.questions.filter(q => q.surveyId === surveyId);
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

    if (store.questions.find(q => q.surveyId === surveyId && q.questionId === newQuestionId)) {
      return res.status(400).json({
        error: 'Question ID already exists',
        message: `Question ID "${newQuestionId}" already exists for this survey`,
        details: [{ field: 'newQuestionId', value: newQuestionId }]
      });
    }

    const validation = validator.validateQuestion(duplicatedQuestion, store.surveys, store.questions);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }

    store.questions.push(duplicatedQuestion);
    await writeStore(store);

    res.status(201).json(duplicatedQuestion);
  } catch (error) {
    res.status(500).json({ error: 'Failed to duplicate question', message: error.message });
  }
});

// ========== LOCK ROUTES ==========

// POST /api/surveys/:id/lock - Acquire lock
router.post('/:id/lock', requireWriteAccess, async (req, res) => {
  try {
    const store = await readStore();
    const survey = store.surveys.find(s => s.surveyId === req.params.id);

    if (!survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    if (!verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await acquireLock(req.params.id, req.user.id);

    if (result.conflict) {
      return res.status(409).json({
        error: 'Survey is locked',
        lockedBy: result.lockedBy,
        expiresAt: result.expiresAt
      });
    }

    res.json({ message: 'Lock acquired', surveyId: req.params.id });
  } catch (error) {
    console.error('Lock acquire error:', error);
    res.status(500).json({ error: 'Failed to acquire lock', message: error.message });
  }
});

// DELETE /api/surveys/:id/lock - Release lock
router.delete('/:id/lock', async (req, res) => {
  try {
    await releaseLock(req.params.id, req.user.id, req.user.role === 'admin');
    res.json({ message: 'Lock released', surveyId: req.params.id });
  } catch (error) {
    console.error('Lock release error:', error);
    res.status(500).json({ error: 'Failed to release lock', message: error.message });
  }
});

// GET /api/surveys/:id/lock - Get lock status
router.get('/:id/lock', async (req, res) => {
  try {
    await pool.query('DELETE FROM survey_locks WHERE expires_at < NOW()');
    const result = await pool.query(
      `SELECT sl.locked_by, sl.locked_at, sl.expires_at, u.username
       FROM survey_locks sl JOIN users u ON sl.locked_by = u.id
       WHERE sl.survey_id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.json({ locked: false });
    }

    const lock = result.rows[0];
    res.json({
      locked: true,
      lockedBy: lock.username,
      lockedAt: lock.locked_at,
      expiresAt: lock.expires_at,
      isOwner: lock.locked_by === req.user.id
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check lock', message: error.message });
  }
});

// ========== PUBLISH ROUTES ==========

// POST /api/surveys/:id/publish
router.post('/:id/publish', requireWriteAccess, async (req, res) => {
  try {
    if (!isPublishEnabled()) {
      return res.json({ message: 'Publish feature is not enabled', featureEnabled: false });
    }

    const store = await readStore();
    const index = store.surveys.findIndex(s => s.surveyId === req.params.id);

    if (index === -1) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    if (!verifySurveyAccess(store.surveys[index], req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const questions = store.questions.filter(q => q.surveyId === req.params.id);
    if (questions.length === 0) {
      return res.status(400).json({ error: 'Cannot publish a survey with no questions' });
    }

    store.surveys[index].publish = {
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      publishedBy: req.user.username
    };
    await writeStore(store);

    res.json({ message: 'Survey published', publish: store.surveys[index].publish });
  } catch (error) {
    console.error('Publish error:', error);
    res.status(500).json({ error: 'Failed to publish survey', message: error.message });
  }
});

// POST /api/surveys/:id/unpublish
router.post('/:id/unpublish', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to unpublish' });
    }

    const store = await readStore();
    const index = store.surveys.findIndex(s => s.surveyId === req.params.id);

    if (index === -1) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    store.surveys[index].publish = { status: 'DRAFT' };
    await writeStore(store);

    res.json({ message: 'Survey unpublished', publish: store.surveys[index].publish });
  } catch (error) {
    console.error('Unpublish error:', error);
    res.status(500).json({ error: 'Failed to unpublish survey', message: error.message });
  }
});

module.exports = router;
