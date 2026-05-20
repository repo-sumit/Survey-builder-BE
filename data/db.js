const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/fmb_survey_builder';

// Cloud providers require SSL; local dev does not
const isCloudDB = /supabase\.com|neon\.tech|railway\.app|render\.com|cockroachlabs\.com|googleapis\.com|cloudsql/i.test(dbUrl)
  || process.env.NODE_ENV === 'production'
  || process.env.DB_SSL === 'true';

const isVercel = !!process.env.VERCEL;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isCloudDB ? { rejectUnauthorized: false } : false,
  // Serverless: fewer connections, shorter idle (each function is isolated)
  max: isVercel ? 2 : 10,
  idleTimeoutMillis: isVercel ? 10000 : 30000,
  connectionTimeoutMillis: 5000,
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS designation_hierarchy (
        id               SERIAL PRIMARY KEY,
        state_code       TEXT NOT NULL,
        designation_id   INT,
        hierarchy_level  INT  NOT NULL,
        designation_name TEXT NOT NULL,
        medium           TEXT NOT NULL,
        medium_in_english TEXT NOT NULL,
        is_active        BOOLEAN DEFAULT TRUE,
        created_by       TEXT,
        updated_by       TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(state_code, medium_in_english, hierarchy_level)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS state_config (
        state_code          TEXT PRIMARY KEY,
        state_name          TEXT NOT NULL,
        available_languages TEXT NOT NULL DEFAULT ''
      )
    `);

    // Migration: relax designation_id on existing tables
    await client.query(`
      ALTER TABLE designation_hierarchy ALTER COLUMN designation_id DROP NOT NULL
    `).catch(() => {});

    // Migration: drop old unique constraint and add new one
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='designation_hierarchy'
            AND constraint_name='designation_hierarchy_state_code_designation_id_key'
        ) THEN
          ALTER TABLE designation_hierarchy
            DROP CONSTRAINT designation_hierarchy_state_code_designation_id_key;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name='designation_hierarchy'
            AND constraint_name='designation_hierarchy_state_code_medium_in_english_hierarchy_level_key'
        ) THEN
          ALTER TABLE designation_hierarchy
            ADD CONSTRAINT designation_hierarchy_state_code_medium_in_english_hierarchy_level_key
            UNIQUE(state_code, medium_in_english, hierarchy_level);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS access_sheet_latest_dump (
        state_code  TEXT PRIMARY KEY,
        dumped_at   TIMESTAMPTZ DEFAULT NOW(),
        dumped_by   TEXT NOT NULL,
        file_name   TEXT NOT NULL,
        mime_type   TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        file_bytes  BYTEA NOT NULL,
        summary     JSONB NOT NULL DEFAULT '{}'
      )
    `);

    // Audit log — append-only history of mutating actions
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id           SERIAL PRIMARY KEY,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor_id     INT REFERENCES users(id) ON DELETE SET NULL,
        actor_label  TEXT NOT NULL,
        actor_role   TEXT NOT NULL,
        state_code   TEXT,
        action       TEXT NOT NULL,
        entity_type  TEXT,
        entity_id    TEXT,
        metadata     JSONB NOT NULL DEFAULT '{}',
        ip           TEXT,
        user_agent   TEXT
      )
    `);

    // Defensive: if audit_logs predates this code with a different schema,
    // backfill missing columns instead of crashing on the index creates below.
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id    INT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_label TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_role  TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS state_code  TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action      TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id   TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata    JSONB NOT NULL DEFAULT '{}'`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip          TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent  TEXT`).catch(() => {});
    await client.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});

    // Dual-auth: additive columns on users. Legacy username/password kept nullable.
    await client.query(`ALTER TABLE users ALTER COLUMN username DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE users ALTER COLUMN password DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email             TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id  TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name              TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at        TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at     TIMESTAMPTZ`);

    // Indexes for performance
    await client.query('CREATE INDEX IF NOT EXISTS idx_surveys_state_code ON surveys(state_code)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_questions_survey_id ON questions(survey_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_designation_state ON designation_hierarchy(state_code)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
                          ON users (LOWER(email)) WHERE email IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_id
                          ON users (supabase_user_id) WHERE supabase_user_id IS NOT NULL`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_entity     ON audit_logs(entity_type, entity_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_actor      ON audit_logs(actor_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_state      ON audit_logs(state_code)');

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

    // Seed admin user if env vars are set (legacy username/password path)
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

    // Seed admin invite if email env vars are set (Google Sign-In path)
    const seedEmail = process.env.SEED_ADMIN_EMAIL;
    const seedName = process.env.SEED_ADMIN_NAME;
    if (seedEmail) {
      const existing = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
        [seedEmail]
      );
      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO users (email, name, role, state_code, is_active, invited_at)
           VALUES ($1, $2, 'admin', NULL, TRUE, NOW())`,
          [seedEmail, seedName || null]
        );
        console.log(`Seeded admin invite: ${seedEmail}`);
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
