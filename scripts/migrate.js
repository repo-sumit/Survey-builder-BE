/**
 * One-time migration script: reads data/store.json and inserts into PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/migrate.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { pool, initDB } = require('../data/db');

const STORE_PATH = path.join(__dirname, '..', 'data', 'store.json');

async function migrate() {
  console.log('Starting migration from store.json to PostgreSQL...');

  // Initialize tables
  await initDB();

  // Read JSON file
  if (!fs.existsSync(STORE_PATH)) {
    console.log('No store.json found — nothing to migrate.');
    return;
  }

  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  if (!raw.trim()) {
    console.log('store.json is empty — nothing to migrate.');
    return;
  }

  const data = JSON.parse(raw);
  const surveys = data.surveys || [];
  const questions = data.questions || [];

  console.log(`Found ${surveys.length} surveys and ${questions.length} questions.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const survey of surveys) {
      const publish = survey.publish || { status: 'DRAFT' };
      const stateCode = survey.stateCode || null;

      await client.query(`
        INSERT INTO surveys (survey_id, state_code, data, publish)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (survey_id) DO UPDATE SET
          state_code = $2, data = $3, publish = $4, updated_at = NOW()
      `, [survey.surveyId, stateCode, survey, publish]);
    }

    for (const q of questions) {
      await client.query(`
        INSERT INTO questions (survey_id, question_id, data)
        VALUES ($1, $2, $3)
        ON CONFLICT (survey_id, question_id) DO UPDATE SET
          data = $3, updated_at = NOW()
      `, [q.surveyId, q.questionId, q]);
    }

    await client.query('COMMIT');
    console.log(`Migration complete: ${surveys.length} surveys, ${questions.length} questions inserted.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
