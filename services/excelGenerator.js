const ExcelJS = require('exceljs');

// Language mapping between English names and native scripts
const LANGUAGE_MAPPINGS = {
  'English': 'English',
  'Hindi': 'हिन्दी',
  'Bengali': 'বাংলা',
  'Assamese': 'অসমীয়া',
  'Bodo': 'बड़ो',
  'Gujarati': 'ગુજરાતી',
  'Marathi': 'मराठी',
  'Tamil': 'தமிழ்',
  'Telugu': 'తెలుగు',
  'Punjabi': 'ਪੰਜਾਬੀ'
};

class ExcelGenerator {
  async generateExcel(survey, questions) {
    const workbook = new ExcelJS.Workbook();

    // Sheet 1: Survey Master
    this.createSurveyMasterSheet(workbook, survey);

    // Sheet 2: Question Master (with multi-language duplication)
    this.createQuestionMasterSheet(workbook, survey, questions);

    return workbook;
  }
  
  getNativeScript(englishName) {
    return LANGUAGE_MAPPINGS[englishName] || englishName;
  }

  createSurveyMasterSheet(workbook, survey) {
    const sheet = workbook.addWorksheet('Survey Master');

    // Define columns in exact order as per specification
    const columns = [
      { header: 'Survey ID', key: 'surveyId', width: 20 },
      { header: 'Survey Name', key: 'surveyName', width: 30 },
      { header: 'Survey Description', key: 'surveyDescription', width: 50 },
      { header: 'available_mediums', key: 'availableMediums', width: 20 },
      { header: 'Hierarchical Access Level', key: 'hierarchicalAccessLevel', width: 25 },
      { header: 'Public', key: 'public', width: 10 },
      { header: 'In School', key: 'inSchool', width: 10 },
      { header: 'Accept multiple Entries', key: 'acceptMultipleEntries', width: 20 },
      { header: 'Launch Date', key: 'launchDate', width: 20 },
      { header: 'Close Date', key: 'closeDate', width: 20 },
      { header: 'Mode', key: 'mode', width: 15 },
      { header: 'visible_on_report_bot', key: 'visibleOnReportBot', width: 20 },
      { header: 'Is Active?', key: 'isActive', width: 10 },
      { header: 'Download_response', key: 'downloadResponse', width: 20 },
      { header: 'Geo Fencing', key: 'geoFencing', width: 15 },
      { header: 'Geo Tagging', key: 'geoTagging', width: 15 },
      { header: 'Test Survey', key: 'testSurvey', width: 15 }
    ];

    sheet.columns = columns;

    // Add survey data
    sheet.addRow({
      surveyId: survey.surveyId || '',
      surveyName: survey.surveyName || '',
      surveyDescription: survey.surveyDescription || '',
      availableMediums: survey.availableMediums || '',
      hierarchicalAccessLevel: survey.hierarchicalAccessLevel || '',
      public: survey.public || 'No',
      inSchool: survey.inSchool || 'No',
      acceptMultipleEntries: survey.acceptMultipleEntries || 'No',
      launchDate: survey.launchDate || '',
      closeDate: survey.closeDate || '',
      mode: survey.mode || 'None',
      visibleOnReportBot: survey.visibleOnReportBot || 'No',
      isActive: survey.isActive || 'No',
      downloadResponse: survey.downloadResponse || 'No',
      geoFencing: survey.geoFencing || 'No',
      geoTagging: survey.geoTagging || 'No',
      testSurvey: survey.testSurvey || 'No'
    });
  }

  createQuestionMasterSheet(workbook, survey, questions) {
    const sheet = workbook.addWorksheet('Question Master');

    // Define all 84 columns in exact order as per specification
    const columns = [
      { header: 'Survey ID', key: 'surveyId', width: 20 },
      { header: 'Medium', key: 'medium', width: 15 },
      { header: 'Medium_in_english', key: 'mediumInEnglish', width: 20 },
      { header: 'Question_ID', key: 'questionId', width: 15 },
      { header: 'Question Type', key: 'questionType', width: 30 },
      { header: 'IsDynamic', key: 'isDynamic', width: 10 },
      { header: 'Question_Description_Optional', key: 'questionDescriptionOptional', width: 30 },
      { header: 'Max_Value', key: 'maxValue', width: 12 },
      { header: 'Min_Value', key: 'minValue', width: 12 },
      { header: 'Is Mandatory', key: 'isMandatory', width: 12 },
      { header: 'Table_Header_value', key: 'tableHeaderValue', width: 30 },
      { header: 'Table_Question_value', key: 'tableQuestionValue', width: 50 },
      { header: 'Source_Question', key: 'sourceQuestion', width: 15 },
      { header: 'Text_input_type', key: 'textInputType', width: 15 },
      { header: 'text_limit_characters', key: 'textLimitCharacters', width: 20 },
      { header: 'Mode', key: 'mode', width: 15 },
      { header: 'Question_Media_Link', key: 'questionMediaLink', width: 30 },
      { header: 'Question_Media_Type', key: 'questionMediaType', width: 20 },
      { header: 'Question Description', key: 'questionDescription', width: 50 },
      { header: 'Question Description', key: 'questionDescriptionDuplicate', width: 50 }
    ];

    // Add 20 options with regional, English, and Children columns
    for (let i = 1; i <= 20; i++) {
      columns.push({ header: `Option_${i}`, key: `option${i}`, width: 30 });
      columns.push({ header: `Option_${i}_in_English`, key: `option${i}InEnglish`, width: 30 });
      columns.push({ header: `Option${i}Children`, key: `option${i}Children`, width: 20 });
    }

    sheet.columns = columns;

    // Parse available mediums from survey
    const surveyLanguages = survey.availableMediums 
      ? (typeof survey.availableMediums === 'string' 
          ? survey.availableMediums.split(',').map(l => l.trim()).filter(l => l)
          : survey.availableMediums)
      : ['English'];

    // Add question data with multi-language duplication
    questions.forEach(question => {
      // If question has translations, use them; otherwise duplicate for each survey language
      if (question.translations && Object.keys(question.translations).length > 0) {
        // New format: question with translations object
        const translationLanguages = Object.keys(question.translations);
        
        translationLanguages.forEach(lang => {
          const translation = question.translations[lang];
          const row = this.buildQuestionRow(question, lang, translation, survey.surveyId);
          sheet.addRow(row);
        });
      } else {
        // Old format or single language: duplicate for each survey language
        surveyLanguages.forEach(lang => {
          const row = this.buildQuestionRow(question, lang, question, survey.surveyId);
          sheet.addRow(row);
        });
      }
    });
  }
  
  buildQuestionRow(question, language, translationData, surveyId) {
    const nativeScript = this.getNativeScript(language);
    
    const row = {
      surveyId: surveyId || question.surveyId || '',
      medium: nativeScript,
      mediumInEnglish: language,
      questionId: question.questionId || '',
      questionType: question.questionType || '',
      isDynamic: question.isDynamic || 'No',
      questionDescriptionOptional: question.questionDescriptionOptional || '',
      maxValue: question.maxValue || '',
      minValue: question.minValue || '',
      isMandatory: question.isMandatory || 'No',
      tableHeaderValue: translationData.tableHeaderValue || question.tableHeaderValue || '',
      tableQuestionValue: translationData.tableQuestionValue || question.tableQuestionValue || '',
      sourceQuestion: question.sourceQuestion || '',
      textInputType: question.textInputType || 'None',
      textLimitCharacters: question.textLimitCharacters || '',
      mode: question.mode || 'None',
      questionMediaLink: (question.questionMediaType === 'None' || question.questionMediaType === '') ? '' : (question.questionMediaLink || ''),
      questionMediaType: question.questionMediaType || 'None',
      questionDescription: translationData.questionDescription || question.questionDescription || '',
      questionDescriptionDuplicate: translationData.questionDescription || question.questionDescription || ''
    };

    // Add options (regional, English, and children)
    const options = translationData.options || question.options || [];
    for (let i = 1; i <= 20; i++) {
      const option = options[i - 1];
      row[`option${i}`] = option?.text || '';
      row[`option${i}InEnglish`] = option?.textInEnglish || option?.text || '';
      row[`option${i}Children`] = option?.children || '';
    }

    return row;
  }
}

module.exports = new ExcelGenerator();
