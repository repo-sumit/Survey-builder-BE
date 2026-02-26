const { pool } = require('./db');
const path = require('path');
const fsp = require('fs').promises;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

async function ensureUploadsDir() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

// ── Survey helpers ──

async function getAllSurveys() {
  const { rows } = await pool.query('SELECT data FROM surveys ORDER BY created_at');
  return rows.map(r => r.data);
}

async function getSurveyById(surveyId) {
  const { rows } = await pool.query('SELECT data FROM surveys WHERE survey_id = $1', [surveyId]);
  return rows.length > 0 ? rows[0].data : null;
}

async function createSurvey(surveyData) {
  await pool.query(
    'INSERT INTO surveys (survey_id, data) VALUES ($1, $2)',
    [surveyData.surveyId, JSON.stringify(surveyData)]
  );
  return surveyData;
}

async function updateSurvey(surveyId, surveyData) {
  const { rowCount } = await pool.query(
    'UPDATE surveys SET data = $1, updated_at = NOW() WHERE survey_id = $2',
    [JSON.stringify(surveyData), surveyId]
  );
  return rowCount > 0;
}

async function deleteSurvey(surveyId) {
  // Questions are deleted via CASCADE
  const { rowCount } = await pool.query('DELETE FROM surveys WHERE survey_id = $1', [surveyId]);
  return rowCount > 0;
}

async function surveyExists(surveyId) {
  const { rows } = await pool.query('SELECT 1 FROM surveys WHERE survey_id = $1', [surveyId]);
  return rows.length > 0;
}

// ── Question helpers ──

async function getQuestionsBySurvey(surveyId) {
  const { rows } = await pool.query(
    'SELECT data FROM questions WHERE survey_id = $1 ORDER BY created_at',
    [surveyId]
  );
  return rows.map(r => r.data);
}

async function getQuestionById(surveyId, questionId) {
  const { rows } = await pool.query(
    'SELECT data FROM questions WHERE survey_id = $1 AND question_id = $2',
    [surveyId, questionId]
  );
  return rows.length > 0 ? rows[0].data : null;
}

async function createQuestion(questionData) {
  await pool.query(
    'INSERT INTO questions (survey_id, question_id, data) VALUES ($1, $2, $3)',
    [questionData.surveyId, questionData.questionId, JSON.stringify(questionData)]
  );
  return questionData;
}

async function updateQuestion(surveyId, questionId, questionData) {
  const { rowCount } = await pool.query(
    'UPDATE questions SET data = $1, updated_at = NOW() WHERE survey_id = $2 AND question_id = $3',
    [JSON.stringify(questionData), surveyId, questionId]
  );
  return rowCount > 0;
}

async function deleteQuestion(surveyId, questionId) {
  const { rowCount } = await pool.query(
    'DELETE FROM questions WHERE survey_id = $1 AND question_id = $2',
    [surveyId, questionId]
  );
  return rowCount > 0;
}

async function questionExists(surveyId, questionId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM questions WHERE survey_id = $1 AND question_id = $2',
    [surveyId, questionId]
  );
  return rows.length > 0;
}

async function deleteQuestionsBySurvey(surveyId) {
  await pool.query('DELETE FROM questions WHERE survey_id = $1', [surveyId]);
}

async function getAllQuestions() {
  const { rows } = await pool.query('SELECT data FROM questions ORDER BY created_at');
  return rows.map(r => r.data);
}

// ── Bulk operations (for import) ──

async function bulkImport(surveys, questions, overwriteSurveyIds = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Remove existing data for overwritten surveys
    for (const sid of overwriteSurveyIds) {
      await client.query('DELETE FROM surveys WHERE survey_id = $1', [sid]);
    }

    // Insert surveys
    for (const s of surveys) {
      await client.query(
        'INSERT INTO surveys (survey_id, data) VALUES ($1, $2)',
        [s.surveyId, JSON.stringify(s)]
      );
    }

    // Insert questions
    for (const q of questions) {
      await client.query(
        'INSERT INTO questions (survey_id, question_id, data) VALUES ($1, $2, $3)',
        [q.surveyId, q.questionId, JSON.stringify(q)]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Legacy readStore/writeStore compatibility (used by validator during import) ──

async function readStore() {
  const surveys = await getAllSurveys();
  const questions = await getAllQuestions();
  return { surveys, questions };
}

module.exports = {
  UPLOAD_DIR,
  ensureUploadsDir,
  // Survey
  getAllSurveys,
  getSurveyById,
  createSurvey,
  updateSurvey,
  deleteSurvey,
  surveyExists,
  // Question
  getQuestionsBySurvey,
  getQuestionById,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  questionExists,
  deleteQuestionsBySurvey,
  getAllQuestions,
  // Bulk
  bulkImport,
  // Legacy
  readStore
};
