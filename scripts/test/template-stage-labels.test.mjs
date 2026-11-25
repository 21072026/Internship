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

test('a stage retired from the preset (#2840) still localizes for an org that kept it', () => {
  const stored = [row('DEAL_NEGOTIATION', 'Negotiation', 0), row('TRIAL_EXPIRED', 'Trial expired', 1)];
  assert.deepEqual(localizeResolvedStageLabels(stored, 'de').map((s) => s.label), ['Verhandlung', 'Testphase abgelaufen']);
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

test('a stage-change notification snapshot follows the reader, a typed label does not', async () => {
  const { renderNotification } = await import('../../src/lib/notificationText.ts');
  const t = { notifications: { events: { 'stage.changed': '{from} → {to}' }, generic: '?' }, interviewDeclineReasons: {} };
  const n = (toLabel) => ({ type: 'stage.changed', params: { from: 'LEAD_NEW', to: 'DEAL_PROPOSAL', fromLabel: 'New lead', toLabel } });
  assert.equal(renderNotification(n('Proposal sent'), t, 'tr'), 'Yeni aday → Teklif gönderildi');
  assert.equal(renderNotification(n('Our offer'), t, 'tr'), 'Yeni aday → Our offer');
});

test('"Qualified" reads "Bedarf geklärt" in German; the old default "Qualifiziert" counts as ours, a typed label stays (#3907)', () => {
  // The English-provisioned row and a row that still stores the old German default both read today's label.
  assert.deepEqual(localizeResolvedStageLabels([row('LEAD_QUALIFIED', 'Qualified')], 'de').map((s) => s.label), ['Bedarf geklärt']);
  assert.deepEqual(localizeResolvedStageLabels([row('LEAD_QUALIFIED', 'Qualifiziert')], 'de').map((s) => s.label), ['Bedarf geklärt']);
  assert.deepEqual(localizeResolvedStageLabels([row('LEAD_QUALIFIED', 'Qualifiziert')], 'en').map((s) => s.label), ['Qualified']);
  // A label the tenant typed is theirs, in every language.
  assert.deepEqual(localizeResolvedStageLabels([row('LEAD_QUALIFIED', 'Bedarf erkannt')], 'de').map((s) => s.label), ['Bedarf erkannt']);
  assert.deepEqual(localizeResolvedStageLabels([row('LEAD_QUALIFIED', 'Bedarf erkannt')], 'en').map((s) => s.label), ['Bedarf erkannt']);
});

test('a former label is ours only for its own key', async () => {
  const { isOurStageLabel } = await import('../../src/lib/programTemplates.ts');
  assert.equal(isOurStageLabel('LEAD_QUALIFIED', 'Qualifiziert'), true);
  assert.equal(isOurStageLabel('LEAD_QUALIFIED', 'Bedarf geklärt'), true);
  assert.equal(isOurStageLabel('LEAD_QUALIFIED', ''), true);
  assert.equal(isOurStageLabel('LEAD_CONTACTED', 'Qualifiziert'), false);
  assert.equal(isOurStageLabel('LEAD_QUALIFIED', 'Hot lead'), false);
});
