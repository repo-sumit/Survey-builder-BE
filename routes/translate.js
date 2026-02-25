const express = require('express');
const http = require('http');
const https = require('https');

const router = express.Router();

const TRANSLATE_API_URL = process.env.TRANSLATE_API_URL || 'https://libretranslate.de/translate';
const TRANSLATE_API_KEY = process.env.TRANSLATE_API_KEY || '';
const TRANSLATE_TIMEOUT_MS = Number.parseInt(process.env.TRANSLATE_TIMEOUT_MS || '10000', 10);

function sendStructuredError(res, status, error, message, details = []) {
  return res.status(status).json({
    status,
    error,
    message,
    details,
    errors: [message]
  });
}

router.post('/', (req, res) => {
  const { text, source = 'en', target } = req.body || {};
  const timeoutMs = Number.isFinite(TRANSLATE_TIMEOUT_MS) && TRANSLATE_TIMEOUT_MS > 0
    ? TRANSLATE_TIMEOUT_MS
    : 10000;

  if (!text || !target) {
    return sendStructuredError(
      res,
      400,
      'Missing text or target language',
      'Both "text" and "target" are required for translation',
      [{ field: !text ? 'text' : 'target' }]
    );
  }

  let url;
  try {
    url = new URL(TRANSLATE_API_URL);
  } catch (error) {
    return sendStructuredError(
      res,
      500,
      'Invalid translation API URL',
      'TRANSLATE_API_URL must be a valid absolute URL',
      [{ value: TRANSLATE_API_URL }]
    );
  }

  const payload = {
    q: text,
    source,
    target,
    format: 'text'
  };

  if (TRANSLATE_API_KEY) {
    payload.api_key = TRANSLATE_API_KEY;
  }

  const body = JSON.stringify(payload);

  const transport = url.protocol === 'http:' ? http : https;
  let responded = false;

  const finalizeError = (status, message, details = []) => {
    if (responded) return;
    responded = true;
    sendStructuredError(res, status, 'Translation failed', message, details);
  };

  const finalizeSuccess = (translatedText) => {
    if (responded) return;
    responded = true;
    res.json({ translatedText });
  };

  const request = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    },
    (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return finalizeError(502, 'Upstream translation service returned a non-success status', [
            { upstreamStatus: response.statusCode },
            { upstreamBody: data }
          ]);
        }

        try {
          const parsed = JSON.parse(data);
          const translatedText = parsed.translatedText || parsed.translation || '';
          return finalizeSuccess(translatedText);
        } catch (error) {
          return finalizeError(
            502,
            'Upstream translation response was not valid JSON',
            [{ upstreamBody: data }]
          );
        }
      });
    }
  );

  request.setTimeout(timeoutMs, () => {
    request.destroy(new Error(`Translation request timed out after ${timeoutMs}ms`));
  });

  request.on('error', (error) => {
    finalizeError(502, error.message, [{ code: error.code || 'UNKNOWN' }]);
  });

  request.write(body);
  request.end();
});

module.exports = router;
