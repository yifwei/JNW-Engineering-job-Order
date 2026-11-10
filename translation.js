'use strict';

const failure = (status, message) => Object.assign(new Error(message), { status });

// Keep Translator credentials on the server. Neither input nor output is logged.
async function translateToEnglish(payload, { env = process.env, fetchImpl = fetch } = {}) {
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
    throw failure(400, 'Enter Chinese or Tamil text first.');
  }
  if (payload.text.length > 5000) {
    throw failure(400, 'Please translate no more than 5,000 characters at a time.');
  }
  if (!env.AZURE_TRANSLATOR_KEY) {
    throw failure(503, 'Translation is not configured yet. Your text has been kept.');
  }
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Ocp-Apim-Subscription-Key': env.AZURE_TRANSLATOR_KEY,
  };
  if (env.AZURE_TRANSLATOR_REGION) {
    headers['Ocp-Apim-Subscription-Region'] = env.AZURE_TRANSLATOR_REGION;
  }
  let response;
  try {
    response = await fetchImpl(
      'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en',
      {
        method: 'POST', headers,
        body: JSON.stringify([{ Text: payload.text }]),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw failure(502, 'Translation could not connect. Your text has been kept. Please try again.');
  }
  if (!response.ok) {
    throw failure(response.status === 429 ? 429 : 502,
      'Translation is temporarily unavailable. Your text has been kept. Please try again later.');
  }
  let result;
  try {
    const data = await response.json();
    result = data?.[0]?.translations?.find((item) => item.to === 'en')?.text;
  } catch { /* Return a safe message without exposing upstream details. */ }
  if (typeof result !== 'string' || !result.trim()) {
    throw failure(502, 'Translation returned no text. Your text has been kept. Please try again.');
  }
  return { text: result };
}

module.exports = { translateToEnglish };
