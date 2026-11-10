'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translateToEnglish } = require('../translation');
const { installTranslation } = require('../translate-form');

const env = { AZURE_TRANSLATOR_KEY: 'test-key', AZURE_TRANSLATOR_REGION: 'southeastasia' };
const success = (text) => ({ ok: true, json: async () => [{ translations: [{ to: 'en', text }] }] });

for (const text of ['水泵漏水', 'தண்ணீர் பம்பில் கசிவு உள்ளது']) {
  test(`passes native-language input to Translator and returns English: ${text}`, async () => {
    const result = await translateToEnglish({ text }, { env, fetchImpl: async (url, options) => {
      assert.equal(new URL(url).searchParams.get('to'), 'en');
      assert.equal(new URL(url).searchParams.has('from'), false);
      assert.deepEqual(JSON.parse(options.body), [{ Text: text }]);
      assert.equal(options.headers['Ocp-Apim-Subscription-Key'], 'test-key');
      assert.equal(options.headers['Ocp-Apim-Subscription-Region'], 'southeastasia');
      return success('The water pump is leaking.');
    } });
    assert.deepEqual(result, { text: 'The water pump is leaking.' });
  });
}

test('rejects invalid/oversized input without contacting the provider', async () => {
  for (const payload of [null, {}, { text: 4 }, { text: '  ' }, { text: 'x'.repeat(5001) }]) {
    await assert.rejects(translateToEnglish(payload, { env, fetchImpl: () => assert.fail('unexpected request') }), { status: 400 });
  }
});

test('missing configuration gives actionable 503 without making a request', async () => {
  await assert.rejects(translateToEnglish({ text: '水泵' }, { env: {}, fetchImpl: () => assert.fail('unexpected request') }), { status: 503 });
});

test('provider failures are sanitized and malformed responses rejected', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private provider details'); },
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: true, json: async () => { throw new Error('private response'); } }),
    async () => ({ ok: true, json: async () => [] }),
  ]) {
    await assert.rejects(translateToEnglish({ text: '水泵' }, { env, fetchImpl }), (error) => {
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /private|test-key/);
      return true;
    });
  }
  await assert.rejects(translateToEnglish({ text: '水泵' }, { env,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  }), { status: 429 });
});

function setup(fetchImpl, initial = '水泵漏水') {
  let click;
  let saves = 0;
  const field = { value: initial, focus() {} };
  const button = { dataset: { translate: 'complaint' }, disabled: false,
    addEventListener(type, fn) { assert.equal(type, 'click'); click = fn; } };
  const status = { textContent: '' };
  const form = { elements: { complaint: field }, querySelectorAll: () => [button], querySelector: () => status };
  installTranslation(form, { fetchImpl, saveDraft: () => { saves++; } });
  return { field, button, status, click: () => click(), saves: () => saves };
}

test('button replaces only final text and saves the editable draft', async () => {
  const ui = setup(async (url, options) => {
    assert.equal(url, '/api/translate');
    assert.deepEqual(JSON.parse(options.body), { text: '水泵漏水' });
    return { ok: true, json: async () => ({ text: 'The pump is leaking.' }) };
  });
  await ui.click();
  assert.equal(ui.field.value, 'The pump is leaking.');
  assert.equal(ui.saves(), 1);
  assert.equal(ui.button.disabled, false);
});

test('failed translation preserves input and re-enables button', async () => {
  const ui = setup(async () => ({ ok: false, json: async () => ({ error: 'Service unavailable' }) }));
  await ui.click();
  assert.equal(ui.field.value, '水泵漏水');
  assert.equal(ui.saves(), 0);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.status.textContent, /kept/);
});

test('late translation cannot overwrite typing or a cleared form', async () => {
  for (const newer of ['Updated work', '']) {
    let resolve;
    const ui = setup(() => new Promise((done) => { resolve = done; }));
    const pending = ui.click();
    assert.equal(ui.button.disabled, true);
    ui.field.value = newer;
    resolve({ ok: true, json: async () => ({ text: 'Old translation' }) });
    await pending;
    assert.equal(ui.field.value, newer);
    assert.equal(ui.saves(), 0);
  }
});

test('empty input makes no translation request', async () => {
  const ui = setup(() => assert.fail('unexpected request'), ' ');
  await ui.click();
  assert.equal(ui.saves(), 0);
  assert.equal(ui.button.disabled, false);
});
