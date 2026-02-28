const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pool, initDB } = require('./db');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
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
  ensureUploadsDir
};
