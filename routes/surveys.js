const express = require('express');
const router = express.Router();
const validator = require('../services/validator');
const { readStore, writeStore, listSurveys, getSurvey, getQuestions, getQuestion, upsertSurvey, deleteSurvey: deleteSurveyRow, upsertQuestion, deleteQuestion: deleteQuestionRow } = require('../data/store');
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
    const stateCode = req.user.role !== 'admin' ? req.user.stateCode : null;
    const surveys = await listSurveys(stateCode);
    res.json(surveys);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch surveys', message: error.message });
  }
});

// GET /api/surveys/:id - Get survey by ID
router.get('/:id', async (req, res) => {
  try {
    const survey = await getSurvey(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (!verifySurveyAccess(survey, req.user)) return res.status(403).json({ error: 'Access denied' });
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

    // Check if survey ID already exists (targeted query)
    const existing = await getSurvey(surveyData.surveyId);
    if (existing) {
      return res.status(400).json({
        error: 'Survey ID already exists',
        errors: [`Survey ID "${surveyData.surveyId}" already exists. Please use a unique Survey ID.`]
      });
    }

    await upsertSurvey(surveyData);
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

    const existingSurvey = await getSurvey(req.params.id);
    if (!existingSurvey) {
      return res.status(404).json({ error: 'Survey not found', errors: ['Survey not found'] });
    }

    if (!verifySurveyAccess(existingSurvey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Lock check
    const lock = await checkLock(req.params.id, req.user.id);
    if (lock.locked) {
      return res.status(409).json({ error: `Survey is locked by ${lock.lockedBy}` });
    }

    // Preserve stateCode and publish from existing survey if not admin
    if (req.user.role !== 'admin') {
      surveyData.stateCode = existingSurvey.stateCode;
    }
    if (!surveyData.publish) {
      surveyData.publish = existingSurvey.publish || { status: 'DRAFT' };
    }

    await upsertSurvey(surveyData);
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
    const survey = await getSurvey(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (!verifySurveyAccess(survey, req.user)) return res.status(403).json({ error: 'Access denied' });

    // Publish guard
    if (isPublishEnabled() && isPublished(survey)) {
      return res.status(403).json({ error: 'Cannot delete a published survey' });
    }

    await deleteSurveyRow(req.params.id); // CASCADE deletes questions
    res.json({ message: 'Survey deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete survey', message: error.message });
  }
});

// ========== QUESTION ROUTES ==========

// GET /api/surveys/:id/questions - Get questions for a survey
router.get('/:id/questions', async (req, res) => {
  try {
    const survey = await getSurvey(req.params.id);
    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const questions = await getQuestions(req.params.id);
    res.json(questions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch questions', message: error.message });
  }
});

// POST /api/surveys/:id/questions - Add question to survey
router.post('/:id/questions', requireWriteAccess, async (req, res) => {
  try {
    const questionData = { ...req.body, surveyId: req.params.id };

    const survey = await getSurvey(req.params.id);
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

    // Fetch only the current survey + its questions (not all surveys)
    const currentSurvey = await getSurvey(req.params.id);
    const questions = await getQuestions(req.params.id);

    const validation = validator.validateQuestion(questionData, currentSurvey ? [currentSurvey] : [], questions);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Validation failed',
        errors: validation.errors
      });
    }

    // Check duplicate question ID
    const existingQ = await getQuestion(req.params.id, questionData.questionId);
    if (existingQ) {
      return res.status(400).json({
        error: 'Question ID already exists',
        errors: [`Question ID "${questionData.questionId}" already exists for this survey. Please use a unique Question ID.`]
      });
    }

    await upsertQuestion(questionData);
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

    const survey = await getSurvey(req.params.id);
    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard: block questionType change on published survey
    if (isPublishEnabled() && survey && isPublished(survey)) {
      const existingQ = await getQuestion(req.params.id, req.params.questionId);
      if (existingQ && questionData.questionType !== existingQ.questionType) {
        return res.status(403).json({ error: 'Cannot change question type on a published survey' });
      }
    }

    // Lock check
    const lock = await checkLock(req.params.id, req.user.id);
    if (lock.locked) {
      return res.status(409).json({ error: `Survey is locked by ${lock.lockedBy}` });
    }

    const currentSurvey = await getSurvey(req.params.id);
    const questions = await getQuestions(req.params.id);

    const validation = validator.validateQuestion(questionData, currentSurvey ? [currentSurvey] : [], questions);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Validation failed',
        errors: validation.errors
      });
    }

    const existingQ = await getQuestion(req.params.id, req.params.questionId);
    if (!existingQ) {
      return res.status(404).json({ error: 'Question not found', errors: ['Question not found'] });
    }

    await upsertQuestion(questionData);
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
    const survey = await getSurvey(req.params.id);
    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard
    if (isPublishEnabled() && survey && isPublished(survey)) {
      return res.status(403).json({ error: 'Cannot delete questions from a published survey' });
    }

    const existingQ = await getQuestion(req.params.id, req.params.questionId);
    if (!existingQ) return res.status(404).json({ error: 'Question not found' });

    await deleteQuestionRow(req.params.id, req.params.questionId);
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

    const originalSurvey = await getSurvey(req.params.id);
    if (!originalSurvey) return res.status(404).json({ error: 'Survey not found' });
    if (!verifySurveyAccess(originalSurvey, req.user)) return res.status(403).json({ error: 'Access denied' });

    const existingNew = await getSurvey(newSurveyId);
    if (existingNew) return res.status(400).json({ error: 'Survey ID already exists' });

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

    const originalQuestions = await getQuestions(req.params.id);
    const duplicatedQuestions = originalQuestions.map(q => ({
      ...q,
      surveyId: newSurveyId
    }));

    // Write survey + questions in a single pass
    await upsertSurvey(duplicatedSurvey);
    for (const q of duplicatedQuestions) {
      await upsertQuestion(q);
    }

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

    const survey = await getSurvey(surveyId);
    if (survey && !verifySurveyAccess(survey, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Publish guard
    if (isPublishEnabled() && survey && isPublished(survey)) {
      return res.status(403).json({ error: 'Cannot duplicate questions on a published survey' });
    }

    const originalQuestion = await getQuestion(surveyId, questionId);
    if (!originalQuestion) return res.status(404).json({ error: 'Question not found' });

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
      const surveyQuestions = await getQuestions(surveyId);
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

    // Deep-clone the original and strip ALL child-question references so the
    // duplicate is completely independent of any parent-child mapping.
    const safeOriginal = JSON.parse(JSON.stringify(originalQuestion));

    const stripChildrenFromOptions = (opts) => {
      if (!Array.isArray(opts)) return opts;
      return opts.map(opt => (opt && typeof opt === 'object') ? { ...opt, children: '' } : opt);
    };

    if (safeOriginal.translations && typeof safeOriginal.translations === 'object') {
      for (const lang of Object.keys(safeOriginal.translations)) {
        const t = safeOriginal.translations[lang];
        if (t && typeof t === 'object') {
          t.options = stripChildrenFromOptions(t.options);
        }
      }
    }

    const duplicatedQuestion = {
      ...safeOriginal,
      questionId: newQuestionId,
      sourceQuestion: '',
      options: stripChildrenFromOptions(safeOriginal.options)
    };

    const existingQ = await getQuestion(surveyId, newQuestionId);
    if (existingQ) {
      return res.status(400).json({
        error: 'Question ID already exists',
        message: `Question ID "${newQuestionId}" already exists for this survey`,
        details: [{ field: 'newQuestionId', value: newQuestionId }]
      });
    }

    const currentSurvey = await getSurvey(surveyId);
    const questions = await getQuestions(surveyId);

    const validation = validator.validateQuestion(duplicatedQuestion, currentSurvey ? [currentSurvey] : [], questions);

    // Since we've explicitly cleared all child references on the duplicate,
    // any "child mapping conflict" error must come from pre-existing data
    // (not from this duplicate). Skip that specific error class for duplicates.
    const realErrors = (validation.errors || []).filter(err => {
      const msg = typeof err === 'string' ? err : (err?.message || '');
      return !msg.includes('Child question IDs cannot be mapped to multiple');
    });

    if (realErrors.length > 0) {
      const errorMessages = realErrors.map(e => typeof e === 'string' ? e : e.message).filter(Boolean);
      return res.status(400).json({
        error: errorMessages[0] || 'Validation failed',
        message: errorMessages.join(' | '),
        errors: errorMessages
      });
    }

    await upsertQuestion(duplicatedQuestion);
    res.status(201).json(duplicatedQuestion);
  } catch (error) {
    console.error('Duplicate question error:', error);
    res.status(500).json({ error: 'Failed to duplicate question', message: error.message });
  }
});

// ========== LOCK ROUTES ==========

// POST /api/surveys/:id/lock - Acquire lock
router.post('/:id/lock', requireWriteAccess, async (req, res) => {
  try {
    const survey = await getSurvey(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (!verifySurveyAccess(survey, req.user)) return res.status(403).json({ error: 'Access denied' });

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

    const survey = await getSurvey(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (!verifySurveyAccess(survey, req.user)) return res.status(403).json({ error: 'Access denied' });

    const questions = await getQuestions(req.params.id);
    if (questions.length === 0) {
      return res.status(400).json({ error: 'Cannot publish a survey with no questions' });
    }

    survey.publish = {
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      publishedBy: req.user.username
    };
    await upsertSurvey(survey);

    res.json({ message: 'Survey published', publish: survey.publish });
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

    const survey = await getSurvey(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });

    survey.publish = { status: 'DRAFT' };
    await upsertSurvey(survey);

    res.json({ message: 'Survey unpublished', publish: survey.publish });
  } catch (error) {
    console.error('Unpublish error:', error);
    res.status(500).json({ error: 'Failed to unpublish survey', message: error.message });
  }
});

module.exports = router;
