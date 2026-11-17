// Unit tests for stage descriptions (#3660): what a stage means, shown behind
// the board header's info icon. Same rule as the labels (#2268): a blank or
// curated description follows the reader's language, a typed one is verbatim,
// and a stage with neither has none (so the board draws no empty icon).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { localizeResolvedStageLabels, isCuratedStageDescription, resolvedStageDescription, PROGRAM_TEMPLATES, validateProgramTemplate } =
  await import('../../src/lib/programTemplates.ts');

const row = (key, description) => ({ key, label: '', order: 0, isTerminal: false, isOffPath: false, color: null, description });

test('a curated stage with nothing stored explains itself in the reader\'s language', () => {
  assert.equal(resolvedStageDescription('LEAD_QUALIFIED', null, 'tr'), 'Müşterinin ne istediği belli, talebi netleşti.');
  assert.match(resolvedStageDescription('LEAD_QUALIFIED', '', 'en'), /clear/);
  assert.match(resolvedStageDescription('LEAD_QUALIFIED', '  ', 'de'), /Kunde/);
});

test('a stored copy of the curated text in another language still follows the reader', () => {
  const en = resolvedStageDescription('DEAL_WON', null, 'en');
  assert.equal(isCuratedStageDescription('DEAL_WON', en), true);
  assert.equal(resolvedStageDescription('DEAL_WON', en, 'tr'), 'Müşteri ücretli bir plan seçti.');
});

test('a description the tenant typed is shown verbatim, trimmed', () => {
  assert.equal(isCuratedStageDescription('LEAD_QUALIFIED', 'Budget confirmed'), false);
  assert.equal(resolvedStageDescription('LEAD_QUALIFIED', ' Budget confirmed ', 'tr'), 'Budget confirmed');
  assert.equal(resolvedStageDescription('MY_OWN_STAGE', 'Ours', 'en'), 'Ours');
});

test('a stage with no curated text and nothing typed has no description', () => {
  assert.equal(resolvedStageDescription('APPLICATION_100', null, 'en'), null);
  assert.equal(resolvedStageDescription('MY_OWN_STAGE', '', 'tr'), null);
});

test('the resolver fills description on every stage it localizes', () => {
  const out = localizeResolvedStageLabels([row('LEAD_NEW', null), row('APPLICATION_100', undefined), row('LEAD_LOST_X', 'Typed')], 'de');
  assert.match(out[0].description, /Kontakt/);
  assert.equal(out[1].description, null);
  assert.equal(out[2].description, 'Typed');
});

test('every template still passes the catalogue validator', () => {
  for (const t of PROGRAM_TEMPLATES) assert.deepEqual(validateProgramTemplate(t), [], t.key);
});
