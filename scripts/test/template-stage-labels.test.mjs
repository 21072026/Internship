// Unit tests for localizing a provisioned template's stage labels.
//
// WHY THIS FILE EXISTS
//   A MARKETING org is provisioned with the marketing funnel's labels written
//   in ONE language (English) into PipelineStage.label. The read-side
//   localizer only knew the canonical keys, so a Turkish admin saw "New lead",
//   "Proposal sent" … on an otherwise Turkish dashboard. These pin that an
//   untouched curated label follows the reader's locale, while a label the
//   tenant actually typed is kept verbatim (the #2268 rule).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { localizeResolvedStageLabels } = await import('../../src/lib/programTemplates.ts');

const row = (key, label, order = 0) => ({ key, label, order, isTerminal: false, isOffPath: false, color: null });

test('an English-provisioned marketing stage reads back in Turkish and German', () => {
  const stored = [row('LEAD_NEW', 'New lead', 0), row('DEAL_PROPOSAL', 'Proposal sent', 1), row('DEAL_LOST', 'Lost', 2)];
  assert.deepEqual(localizeResolvedStageLabels(stored, 'tr').map((s) => s.label), ['Yeni aday', 'Teklif gönderildi', 'Kaybedildi']);
  assert.deepEqual(localizeResolvedStageLabels(stored, 'de').map((s) => s.label), ['Neuer Lead', 'Angebot gesendet', 'Verloren']);
});

test('a curated label stored in another locale, or blank, is localized too', () => {
  const stored = [row('LEAD_CONTACTED', 'Kontaktiert'), row('DEAL_WON', '  ')];
  assert.deepEqual(localizeResolvedStageLabels(stored, 'en').map((s) => s.label), ['Contacted', 'Won']);
});

test('a label the tenant typed is kept verbatim', () => {
  const stored = [row('LEAD_NEW', 'Inbound — fresh'), row('MY_OWN_STAGE', 'Something else')];
  assert.deepEqual(localizeResolvedStageLabels(stored, 'tr').map((s) => s.label), ['Inbound — fresh', 'Something else']);
});

test('canonical stages keep their existing localization', () => {
  const stored = [row('APPLICATION_100', '')];
  const [en] = localizeResolvedStageLabels(stored, 'en');
  const [tr] = localizeResolvedStageLabels(stored, 'tr');
  assert.ok(en.label && tr.label && en.label !== tr.label);
});
