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
app.use(cors());
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

// Root route
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
    await ensureUploadsDir();
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;
