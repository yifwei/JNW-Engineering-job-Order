'use strict';

function installTranslation(form, { saveDraft, fetchImpl = fetch }) {
  for (const button of form.querySelectorAll('[data-translate]')) {
    const field = form.elements[button.dataset.translate];
    const status = form.querySelector(`#${button.dataset.translate}TranslationStatus`);
    button.addEventListener('click', async () => {
      const original = field.value;
      if (!original.trim()) {
        status.textContent = 'Enter Chinese or Tamil text first.';
        field.focus();
        return;
      }
      button.disabled = true;
      status.textContent = 'Translating to English…';
      try {
        const response = await fetchImpl('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: original }),
          signal: AbortSignal.timeout(20000),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Translation failed. Please try again.');
        if (typeof result.text !== 'string' || !result.text.trim()) {
          throw new Error('Translation returned no text. Please try again.');
        }
        // Typing, resetting or submitting while waiting must not overwrite newer work.
        if (field.value !== original) {
          status.textContent = 'Text changed while translating. Press Translate again.';
          return;
        }
        field.value = result.text;
        saveDraft();
        status.textContent = 'Translated. Review and edit the English before submitting.';
      } catch (error) {
        status.textContent = `Your text has been kept. ${error.message || 'Please try again.'}`;
      } finally {
        button.disabled = false;
      }
    });
  }
}

if (typeof module !== 'undefined') module.exports = { installTranslation };
