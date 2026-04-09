const express = require('express');
const router = express.Router();
const excelGenerator = require('../services/excelGenerator');
const { getSurvey, getQuestions } = require('../data/store');

// GET /api/export/:surveyId - Export survey to Excel
router.get('/:surveyId', async (req, res) => {
  try {
    const survey = await getSurvey(req.params.surveyId);
    if (!survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }

    // State scoping
    if (req.user && req.user.role !== 'admin') {
      if (!survey.stateCode || survey.stateCode !== req.user.stateCode) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get questions for survey
    const questions = await getQuestions(req.params.surveyId);
    
    // Generate Excel
    const workbook = await excelGenerator.generateExcel(survey, questions);
    
    // Set response headers
    const rawFilename = `${survey.surveyId}_dump.xlsx`;
    const safeFilename = rawFilename.replace(/["\\]/g, '_');
    const encodedFilename = encodeURIComponent(rawFilename);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
    );
    
    // Write to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export survey', message: error.message });
    }
  }
});

module.exports = router;
