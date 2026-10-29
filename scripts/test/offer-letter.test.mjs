// The offer letter rule (#1857): allowlisted merge tags, nothing evaluated,
// and text the PDF's WinAnsi fonts can always draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_TAGS, compensationLine, pdfSafeText, renderOfferLetter, sampleMergeValues, unknownMergeTags } from '../../src/lib/offerLetter.ts';
import { BUILT_IN_OFFER_LETTERS } from '../../src/lib/offerLetterTemplates.ts';

const values = sampleMergeValues('en');

test('every allowlisted tag is replaced', () => {
  const body = MERGE_TAGS.map((t) => `{{${t}}}`).join('|');
  assert.equal(renderOfferLetter(body, values), MERGE_TAGS.map((t) => values[t]).join('|'));
});

test('an unknown tag renders literally and nothing is evaluated', () => {
  for (const raw of ['{{salary}}', '{{constructor}}', '{{__proto__}}', '{{ position }}', '{{position.length}}', '{{toString}}']) {
    assert.equal(renderOfferLetter(raw, values), raw);
  }
  assert.deepEqual(unknownMergeTags('{{position}} {{salary}} {{salary}}'), ['salary']);
});

test('a value is inserted as text, never re-scanned for tags', () => {
  const v = { ...values, candidateName: '{{compensation}}' };
  assert.equal(renderOfferLetter('{{candidateName}}', v), '{{compensation}}');
});

test('the built-in letter exists in every locale and uses only known tags', () => {
  for (const locale of ['en', 'tr', 'de']) {
    assert.ok(BUILT_IN_OFFER_LETTERS[locale].length > 100);
    assert.deepEqual(unknownMergeTags(BUILT_IN_OFFER_LETTERS[locale]), []);
    assert.ok(!renderOfferLetter(BUILT_IN_OFFER_LETTERS[locale], sampleMergeValues(locale)).includes('{{'));
  }
});

test('Turkish letters the standard fonts cannot draw are folded; others survive', () => {
  assert.equal(pdfSafeText('Ağır Şişli İğdır ıı'), 'Agir Sisli Igdir ii');
  assert.equal(pdfSafeText('Müller Größe Çağ — €5 “ok”'), 'Müller Größe Çag — €5 “ok”');
  assert.equal(pdfSafeText('emoji 😀 漢'), 'emoji ? ?');
});

test('the compensation line reads the structured figures, then the note', () => {
  const labels = { perPeriod: { MONTHLY: 'per month' }, hoursPerWeek: '{n} h/week', signingBonus: 'Signing bonus {amount}', otherBonus: 'Other {amount}', equity: 'Equity: {note}' };
  const money = (m, cur) => `${cur} ${(m / 100).toFixed(2)}`;
  const line = compensationLine({ currency: 'EUR', baseAmountMinor: 240000, basePeriod: 'MONTHLY', hoursPerWeek: 20, compensationNote: ' plus lunch ' }, labels, money);
  assert.match(line, /^EUR 2400\.00 per month/);
  assert.match(line, /per month · 20 h\/week · plus lunch$/);
  assert.equal(compensationLine({}, labels, money), '—');
});
