// Unit tests for the agenda resolver (#1841) — src/lib/agendasRule.ts, the
// dependency-free half of src/lib/agendas.ts.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The acceptance criterion is the fallback chain: `resolveItemText` returns
// the reader's locale, falls back to defaultLocale, then to the canonical
// string — and an ad-hoc item (no template item) is its own text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const {
  normalizeAgendaTranslations,
  readAgendaTranslations,
  canonicalPrompt,
  resolveTemplateText,
  resolveItemText,
} = await import('../../src/lib/agendasRule.ts');

test('normalize keeps known locales with text, trims, bounds to the column width', () => {
  assert.deepEqual(normalizeAgendaTranslations({ en: '  Kickoff ', tr: '', fr: 'x', de: 'Auftakt', nope: 1 }), {
    en: 'Kickoff',
    de: 'Auftakt',
  });
  assert.deepEqual(normalizeAgendaTranslations(null), {});
  assert.deepEqual(normalizeAgendaTranslations('string'), {});
  const long = 'a'.repeat(400);
  assert.equal(normalizeAgendaTranslations({ en: long }).en.length, 191);
  // Reading a stored column back does not re-bound it (a summary is longer than a title).
  assert.equal(readAgendaTranslations({ en: long }).en.length, 400);
});

test('canonicalPrompt: the default locale, else the first filled language, else the fallback', () => {
  assert.equal(canonicalPrompt({ en: 'Kickoff', tr: 'Tanışma' }), 'Kickoff');
  assert.equal(canonicalPrompt({ tr: 'Tanışma', de: 'Auftakt' }), 'Tanışma');
  assert.equal(canonicalPrompt({}, '  Fallback  '), 'Fallback');
  assert.equal(canonicalPrompt({}), '');
});

test('resolveTemplateText: reader locale → default locale → canonical text', () => {
  const src = { text: 'CANON', translations: { en: 'English', tr: 'Türkçe' } };
  assert.equal(resolveTemplateText(src, 'tr'), 'Türkçe');
  assert.equal(resolveTemplateText(src, 'de'), 'English');
  assert.equal(resolveTemplateText(src, 'xx'), 'English');
  assert.equal(resolveTemplateText(src, null), 'English');
  assert.equal(resolveTemplateText({ text: 'CANON', translations: { tr: 'Türkçe' } }, 'de'), 'CANON');
  assert.equal(resolveTemplateText({ text: 'CANON' }, 'tr'), 'CANON');
  // A blank translation does not win over the fallback.
  assert.equal(resolveTemplateText({ text: 'CANON', translations: { de: '   ' } }, 'de'), 'CANON');
});

test('resolveItemText: templated items read the template live, ad-hoc items are their own text', () => {
  const templated = {
    text: 'snapshot taken at instantiation',
    templateItem: { prompt: 'What went well since we last spoke?', translations: { tr: 'Son görüşmemizden bu yana ne iyi gitti?' } },
  };
  assert.equal(resolveItemText(templated, 'tr'), 'Son görüşmemizden bu yana ne iyi gitti?');
  assert.equal(resolveItemText(templated, 'de'), 'What went well since we last spoke?');
  assert.equal(resolveItemText({ text: 'Ask about the visa appointment', templateItem: null }, 'tr'), 'Ask about the visa appointment');
  assert.equal(resolveItemText({ text: 'Ad hoc' }, 'de'), 'Ad hoc');
});
