require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');

const { initStore } = require('./data/store');
const { requireAuth, requireAdmin } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const surveysRouter = require('./routes/surveys');
const exportRouter = require('./routes/export');
const validateUploadRouter = require('./routes/validateUpload');
const validationSchemaRouter = require('./routes/validationSchema');
const importRouter = require('./routes/import');
const translateRouter = require('./routes/translate');
const { router: designationsRouter } = require('./routes/designations');
const accessSheetRouter = require('./routes/accessSheet');
const healthRouter = require('./routes/health');
const readyRouter = require('./routes/ready');

const app = express();
const PORT = process.env.PORT || 5001;

// Lazy DB initialization (required for Vercel serverless cold starts)
let dbReady = false;
let dbInitPromise = null;

function ensureDB() {
  if (dbReady) return Promise.resolve();
  if (!dbInitPromise) {
    dbInitPromise = initStore()
      .then(() => { dbReady = true; })
      .catch(err => {
        dbInitPromise = null; // allow retry on next request
        throw err;
      });
  }
  return dbInitPromise;
}

// Middleware
app.use(compression());  // gzip all responses — major speed boost
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Public health endpoint — mounted BEFORE the ensureDB middleware so that
// external uptime monitors (and the FE warmup probe) can verify Express is
// up without paying the DB-init cost on cold start. Keeping /api/health
// DB-independent is what makes the keep-awake ping actually reduce
// cold-start latency rather than amplify it. See docs/UPTIME_MONITORING.md.
app.use('/api/health', healthRouter);

// DB init middleware — runs once on first request, then becomes a no-op
app.use(async (req, res, next) => {
  try {
    await ensureDB();
    next();
  } catch (err) {
    console.error('Database initialization failed:', err);
    res.status(503).json({ error: 'Database unavailable', message: err.message });
  }
});

// Readiness probe — confirms DB is up. Mounted AFTER ensureDB so the first
// call pays the one-time init cost; subsequent calls become a SELECT 1.
// Separate from /api/health (liveness) because synthetic monitors and deploy
// gates need to fail closed when the DB is unreachable.
app.use('/api/ready', readyRouter);

// Keep-alive endpoint — pings DB to prevent Supabase free-tier pause
app.get('/api/keep-alive', async (req, res) => {
  try {
    const { pool } = require('./data/db');
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', db: 'alive', time: result.rows[0].now });
  } catch (err) {
    console.error('Keep-alive DB ping failed:', err.message);
    res.status(503).json({ status: 'error', db: 'unreachable', message: err.message });
  }
});
app.use('/api/auth', authRouter);

// Protected routes (auth required)
app.use('/api/surveys', requireAuth, surveysRouter);
app.use('/api/export', requireAuth, exportRouter);
app.use('/api/validate-upload', requireAuth, validateUploadRouter);
app.use('/api/validation-schema', requireAuth, validationSchemaRouter);
app.use('/api/import', requireAuth, importRouter);
app.use('/api/translate', requireAuth, translateRouter);
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);
app.use('/api/designations', requireAuth, designationsRouter);
app.use('/api/access-sheet', requireAuth, accessSheetRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.type || 'Internal server error',
    message: err.message || 'Something went wrong',
    errors: err.errors || [err.message || 'Something went wrong']
  });
});

// Start server only when running directly (not on Vercel serverless)
if (!process.env.VERCEL) {
  initStore()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
        console.log(`API available at http://localhost:${PORT}/api`);
      });
    })
    .catch(err => {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    });
}

module.exports = app;
