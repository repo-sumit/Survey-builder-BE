const dns = require('dns');
const { Pool } = require('pg');

// Force IPv4 DNS resolution - fixes Render/Supabase IPv6 connectivity issues
dns.setDefaultResultOrder('ipv4first');

// Validate DATABASE_URL is set in production
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString || 'postgresql://postgres:postgres@localhost:5432/postgres',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

async function initDB() {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to PostgreSQL database');

    await client.query(`
      CREATE TABLE IF NOT EXISTS surveys (
        survey_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        survey_id TEXT NOT NULL REFERENCES surveys(survey_id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(survey_id, question_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_questions_survey_id ON questions(survey_id);
    `);

    console.log('Database tables initialized successfully');
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = { pool, initDB };
