const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pool, initDB } = require('./db');

const UPLOAD_DIR = process.env.VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, '..', 'uploads');
const STORE_PATH = path.join(__dirname, 'store.json'); // kept for migration reference

async function initStore() {
  await initDB();
  await ensureUploadsDir();
}

async function ensureUploadsDir() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

async function readStore() {
  const [surveyRows, questionRows] = await Promise.all([
    pool.query('SELECT data, publish FROM surveys ORDER BY created_at'),
    pool.query('SELECT data FROM questions ORDER BY created_at')
  ]);

  const surveys = surveyRows.rows.map(r => {
    const survey = { ...r.data };
    if (r.publish) {
      survey.publish = r.publish;
    } else if (!survey.publish) {
      survey.publish = { status: 'DRAFT' };
    }
    return survey;
  });

  const questions = questionRows.rows.map(r => r.data);

  return { surveys, questions };
}

/* ─── Targeted queries — avoid loading the entire store ─── */

/** List surveys only (no questions loaded). Optionally filter by stateCode. */
async function listSurveys(stateCode) {
  const query = stateCode
    ? 'SELECT data, publish FROM surveys WHERE state_code = $1 ORDER BY created_at'
    : 'SELECT data, publish FROM surveys ORDER BY created_at';
  const params = stateCode ? [stateCode] : [];
  const { rows } = await pool.query(query, params);
  return rows.map(r => {
    const survey = { ...r.data };
    survey.publish = r.publish || survey.publish || { status: 'DRAFT' };
    return survey;
  });
}

/** Check which survey IDs from a list already exist. Returns array of existing IDs. */
async function findExistingSurveyIds(surveyIds) {
  if (!surveyIds || surveyIds.length === 0) return [];
  const { rows } = await pool.query(
    'SELECT survey_id FROM surveys WHERE survey_id = ANY($1)',
    [surveyIds]
  );
  return rows.map(r => r.survey_id);
}

/** Get a single survey by ID. Returns null if not found. */
async function getSurvey(surveyId) {
  const { rows } = await pool.query(
    'SELECT data, publish FROM surveys WHERE survey_id = $1',
    [surveyId]
  );
  if (rows.length === 0) return null;
  const survey = { ...rows[0].data };
  survey.publish = rows[0].publish || survey.publish || { status: 'DRAFT' };
  return survey;
}

/** Get questions for a single survey. */
async function getQuestions(surveyId) {
  const { rows } = await pool.query(
    'SELECT data FROM questions WHERE survey_id = $1 ORDER BY created_at',
    [surveyId]
  );
  return rows.map(r => r.data);
}

/** Get a single question. Returns null if not found. */
async function getQuestion(surveyId, questionId) {
  const { rows } = await pool.query(
    'SELECT data FROM questions WHERE survey_id = $1 AND question_id = $2',
    [surveyId, questionId]
  );
  return rows.length ? rows[0].data : null;
}

/** Upsert a single survey (without touching questions). */
async function upsertSurvey(survey) {
  const publish = survey.publish || { status: 'DRAFT' };
  const stateCode = survey.stateCode || null;
  await pool.query(`
    INSERT INTO surveys (survey_id, state_code, data, publish, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (survey_id) DO UPDATE SET
      state_code = $2, data = $3, publish = $4, updated_at = NOW()
  `, [survey.surveyId, stateCode, survey, publish]);
}

/** Delete a single survey (cascade deletes its questions). */
async function deleteSurvey(surveyId) {
  await pool.query('DELETE FROM surveys WHERE survey_id = $1', [surveyId]);
}

/** Upsert a single question. */
async function upsertQuestion(question) {
  await pool.query(`
    INSERT INTO questions (survey_id, question_id, data, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (survey_id, question_id) DO UPDATE SET
      data = $3, updated_at = NOW()
  `, [question.surveyId, question.questionId, question]);
}

/** Delete a single question. */
async function deleteQuestion(surveyId, questionId) {
  await pool.query(
    'DELETE FROM questions WHERE survey_id = $1 AND question_id = $2',
    [surveyId, questionId]
  );
}

async function writeStore(data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get existing survey IDs for diffing
    const existingRes = await client.query('SELECT survey_id FROM surveys');
    const existingIds = new Set(existingRes.rows.map(r => r.survey_id));
    const newIds = new Set(data.surveys.map(s => s.surveyId));

    // Delete surveys that are no longer present (cascade deletes their questions)
    for (const id of existingIds) {
      if (!newIds.has(id)) {
        await client.query('DELETE FROM surveys WHERE survey_id = $1', [id]);
      }
    }

    // Upsert surveys
    for (const survey of data.surveys) {
      const publish = survey.publish || { status: 'DRAFT' };
      const stateCode = survey.stateCode || null;

      await client.query(`
        INSERT INTO surveys (survey_id, state_code, data, publish, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (survey_id) DO UPDATE SET
          state_code = $2,
          data = $3,
          publish = $4,
          updated_at = NOW()
      `, [survey.surveyId, stateCode, survey, publish]);
    }

    // Rebuild questions: delete all then re-insert
    await client.query('DELETE FROM questions');
    for (const q of data.questions) {
      await client.query(`
        INSERT INTO questions (survey_id, question_id, data, updated_at)
        VALUES ($1, $2, $3, NOW())
      `, [q.surveyId, q.questionId, q]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  STORE_PATH,
  UPLOAD_DIR,
  initStore,
  readStore,
  writeStore,
  ensureUploadsDir,
  // Targeted queries (performance)
  listSurveys,
  findExistingSurveyIds,
  getSurvey,
  getQuestions,
  getQuestion,
  upsertSurvey,
  deleteSurvey,
  upsertQuestion,
  deleteQuestion
};
