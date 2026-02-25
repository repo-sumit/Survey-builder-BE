const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

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
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

// Serve static files from React app in production
if (process.env.NODE_ENV === 'production') {
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

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);
});

module.exports = app;
