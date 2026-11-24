// MentorshipRelation.nextActionType (#3900): the app's rule
// (src/lib/leadHandoffRule.ts) and the deploy backfill's plain-ESM mirror
// (prisma/next-action-type.mjs) must read a follow-up note the same way, from
// the same labels the dictionary gives the hand-off dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries } from '../../src/i18n/dictionaries.ts';
import { locales } from '../../src/i18n/config.ts';
import { LABELS, actionFromNote } from '../../prisma/next-action-type.mjs';

const { handoffActionFromNote, nextActionTypeFor, followUpInteractionType } = await import('../../src/lib/leadHandoffRule.ts');
const { nextActionPatch } = await import('../../src/lib/nextActionRule.ts');

const DICT_LABELS = locales.map((l) => dictionaries[l].leadHandoff.actions);

test('the mirror carries every locale\'s pick labels, exactly', () => {
  assert.equal(LABELS.length, locales.length);
  locales.forEach((l, i) => {
    const { other, ...picks } = dictionaries[l].leadHandoff.actions;
    void other;
    assert.deepEqual(LABELS[i], picks, `labels of ${l}`);
  });
});

const CORPUS = [
  null,
  '',
  '   ',
  'Call',
  'Call: ask about the trial',
  'Callback later',
  'Telefonla aranacak: ilk tanışma',
  'E-posta atılacak',
  'Randevu yapılacak: Salı',
  'Uygulama demosu yapılacak: ikinci deneme',
  'Anrufen: Preis klären',
  'E-Mail senden',
  'Termin vereinbaren: nächste Woche',
  'App-Demo zeigen',
  'Send the brochure next week',
  'Başka bir şey',
  'Something else: whatever',
];

test('the backfill reads every note the way the app does', () => {
  for (const note of CORPUS) {
    assert.equal(actionFromNote(note), handoffActionFromNote(note, DICT_LABELS), JSON.stringify(note));
  }
  assert.equal(actionFromNote('Telefonla aranacak: ilk tanışma'), 'call');
  assert.equal(actionFromNote('Send the brochure next week'), null);
});

test('a sent pick wins over the note; no pick reads the note; free text is untyped', () => {
  assert.equal(nextActionTypeFor('other', 'Call: x', DICT_LABELS), 'other');
  assert.equal(nextActionTypeFor(null, 'E-Mail senden', DICT_LABELS), 'email');
  assert.equal(nextActionTypeFor(undefined, 'ring them', DICT_LABELS), null);
  assert.equal(nextActionTypeFor(null, null, DICT_LABELS), null);
});

test('"Complete follow-up" opens on the stored pick, falling back to the note', () => {
  assert.equal(followUpInteractionType('free text', DICT_LABELS, 'email'), 'Email');
  assert.equal(followUpInteractionType('free text', DICT_LABELS, 'demo'), 'Meeting');
  assert.equal(followUpInteractionType('E-posta atılacak', DICT_LABELS, null), 'Email');
  assert.equal(followUpInteractionType('E-posta atılacak', DICT_LABELS, 'other'), 'Call');
  assert.equal(followUpInteractionType('x', DICT_LABELS, 'not-a-pick'), 'Call');
});

test('clearing the day and the note clears what the step was', () => {
  const day = new Date('2026-11-20T00:00:00Z');
  assert.equal(nextActionPatch({ nextActionAt: day }, { nextActionAt: null, nextActionNote: null }).nextActionType, null);
  assert.equal(nextActionPatch({ nextActionAt: day }, { nextActionAt: null, nextActionNote: null, nextActionType: 'call' }).nextActionType, null);
  assert.equal(nextActionPatch({ nextActionAt: day }, { nextActionNote: 'x', nextActionType: 'email' }).nextActionType, 'email');
  assert.equal('nextActionType' in nextActionPatch({ nextActionAt: day }, { nextActionAt: day }), false);
});
