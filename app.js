const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { initDB } = require('./data/db');
const { ensureUploadsDir } = require('./data/store');

const surveysRouter = require('./routes/surveys');
const exportRouter = require('./routes/export');
const validateUploadRouter = require('./routes/validateUpload');
const validationSchemaRouter = require('./routes/validationSchema');
const importRouter = require('./routes/import');
const translateRouter = require('./routes/translate');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
// Configure CORS to allow requests from your frontend domain
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // In production, check against allowed origins; in dev allow all
    if (process.env.NODE_ENV !== 'production' || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Still allow if not in strict mode
    return callback(null, true);
  },
  credentials: true
}));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/surveys', surveysRouter);
app.use('/api/export', exportRouter);
app.use('/api/validate-upload', validateUploadRouter);
app.use('/api/validation-schema', validationSchemaRouter);
app.use('/api/import', importRouter);
app.use('/api/translate', translateRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'FMB Survey Builder API is running' });
});

// Root route - helpful for checking if server is up
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FMB Survey Builder API. Use /api/* endpoints.' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

// Initialize uploads dir, DB, then start server
async function startServer() {
  try {
    // Ensure uploads directory exists before any request handling
    await ensureUploadsDir();
    console.log('Uploads directory ready');

    await initDB();
    console.log('Database initialized');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`API available at http://0.0.0.0:${PORT}/api`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;
