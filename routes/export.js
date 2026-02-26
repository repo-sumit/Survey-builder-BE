const express = require('express');
const router = express.Router();
const excelGenerator = require('../services/excelGenerator');
const store = require('../data/store');

// GET /api/export/:surveyId - Export survey to Excel
router.get('/:surveyId', async (req, res) => {
  try {
    const survey = await store.getSurveyById(req.params.surveyId);
    if (!survey) {
      return res.status(404).json({ error: 'Survey not found' });
    }
    
    const questions = await store.getQuestionsBySurvey(req.params.surveyId);
    
    const workbook = await excelGenerator.generateExcel(survey, questions);
    
    const rawFilename = `${survey.surveyId}_dump.xlsx`;
    const safeFilename = rawFilename.replace(/["\\]/g, '_');
    const encodedFilename = encodeURIComponent(rawFilename);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
    
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export survey', message: error.message });
  }
});

module.exports = router;
