const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/fmb_survey_builder';

// Supabase (and most cloud providers) require SSL; local dev does not
const isCloudDB = dbUrl.includes('supabase.com') || dbUrl.includes('neon.tech') || process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isCloudDB ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS surveys (
        survey_id   TEXT PRIMARY KEY,
        state_code  TEXT,
        data        JSONB NOT NULL,
        publish     JSONB NOT NULL DEFAULT '{"status":"DRAFT"}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        survey_id   TEXT NOT NULL REFERENCES surveys(survey_id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        data        JSONB NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (survey_id, question_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        username     TEXT UNIQUE NOT NULL,
        password     TEXT NOT NULL,
        role         TEXT NOT NULL DEFAULT 'state',
        state_code   TEXT,
        is_active    BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS survey_locks (
        survey_id   TEXT PRIMARY KEY REFERENCES surveys(survey_id) ON DELETE CASCADE,
        locked_by   INTEGER NOT NULL REFERENCES users(id),
        locked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
      )
    `);

    // Ensure new columns exist on pre-existing tables (safe to run repeatedly)
    await client.query(`
      ALTER TABLE surveys ADD COLUMN IF NOT EXISTS state_code TEXT
    `);
    await client.query(`
      ALTER TABLE surveys ADD COLUMN IF NOT EXISTS publish JSONB NOT NULL DEFAULT '{"status":"DRAFT"}'
    `);
    await client.query(`
      ALTER TABLE surveys ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await client.query(`
      ALTER TABLE surveys ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);

    await client.query('COMMIT');

    // Seed admin user if env vars are set
    const seedUser = process.env.SEED_ADMIN_USER;
    const seedPass = process.env.SEED_ADMIN_PASSWORD;
    if (seedUser && seedPass) {
      const existing = await pool.query('SELECT id FROM users WHERE username = $1', [seedUser]);
      if (existing.rows.length === 0) {
        const hash = await bcrypt.hash(seedPass, 10);
        await pool.query(
          'INSERT INTO users (username, password, role, state_code, is_active) VALUES ($1, $2, $3, NULL, TRUE)',
          [seedUser, hash, 'admin']
        );
        console.log(`Seeded admin user: ${seedUser}`);
      }
    }

    console.log('Database tables initialized');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
