require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const path = require('path');

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

// Public routes (no auth)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'FMB Survey Builder API is running' });
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

// Serve static files from React app in production (non-Vercel)
if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, '../client/build')));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
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
