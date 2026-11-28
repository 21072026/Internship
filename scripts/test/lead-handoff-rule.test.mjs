// Unit tests for the board hand-off's note rule (src/lib/leadHandoffRule.ts).
//
// The note is what the new owner reads on the record and in their reminder, so
// the three silent failures are: an "other" hand-off with no words (an
// instruction nobody can follow), a note cut at the column width (a wrong
// instruction), and an action outside the list reaching the write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_ACTIONS,
  HANDOFF_NOTE_MAX,
  SALES_HANDOFF_REASON,
  composeHandoffNote,
  isHandoffAction,
  handedOnBy,
  mayReceiveHandoff,
  todayIso,
} from '../../src/lib/leadHandoffRule.ts';

test('a quick pick alone is its label', () => {
  assert.deepEqual(composeHandoffNote('call', 'Telefonla aranacak', ''), { ok: true, value: 'Telefonla aranacak' });
  assert.deepEqual(composeHandoffNote('demo', 'Give an app demo', null), { ok: true, value: 'Give an app demo' });
});

test('a quick pick with words reads "label: words", whitespace folded', () => {
  assert.deepEqual(composeHandoffNote('email', 'Send an e-mail', '  pricing\n tier  '), {
    ok: true,
    value: 'Send an e-mail: pricing tier',
  });
});

test('"other" is the words themselves and needs some', () => {
  assert.deepEqual(composeHandoffNote('other', 'Something else', 'visit the office'), { ok: true, value: 'visit the office' });
  assert.deepEqual(composeHandoffNote('other', 'Something else', '   '), { ok: false, error: 'note_required' });
});

test('over the column width is refused, never cut', () => {
  const words = 'x'.repeat(HANDOFF_NOTE_MAX);
  assert.deepEqual(composeHandoffNote('other', 'Other', words), { ok: true, value: words });
  assert.deepEqual(composeHandoffNote('call', 'Call', words), { ok: false, error: 'too_long' });
});

test('the action list is closed', () => {
  for (const a of HANDOFF_ACTIONS) assert.equal(isHandoffAction(a), true);
  assert.equal(isHandoffAction('delete'), false);
  assert.equal(isHandoffAction(undefined), false);
});

test('its own reason code, not an admin one', () => {
  assert.equal(SALES_HANDOFF_REASON, 'sales_handoff');
});

test('todayIso is the UTC calendar day', () => {
  assert.equal(todayIso(Date.UTC(2026, 10, 13, 23, 59)), '2026-11-13');
});

// "Complete follow-up" opens the interaction form on the hand-off's pick (#3821).
const { followUpInteractionType, handoffActionFromNote } = await import('../../src/lib/leadHandoffRule.ts');

const LABELS = [
  { call: 'Call', email: 'Send an e-mail', meeting: 'Book an appointment', demo: 'Give an app demo', other: 'Something else' },
  { call: 'Telefonla aranacak', email: 'E-posta atılacak', meeting: 'Randevu yapılacak', demo: 'Uygulama demosu yapılacak', other: 'Başka bir şey' },
];

test('the follow-up type follows the hand-off pick, in any language', () => {
  assert.equal(followUpInteractionType('Send an e-mail', LABELS), 'Email');
  assert.equal(followUpInteractionType('Randevu yapılacak: Salı öğleden sonra', LABELS), 'Meeting');
  assert.equal(followUpInteractionType('Uygulama demosu yapılacak', LABELS), 'Meeting');
  assert.equal(followUpInteractionType('Call: ask about the trial', LABELS), 'Call');
  assert.equal(handoffActionFromNote('E-posta atılacak: teklif', LABELS), 'email');
});

test('a note that names no pick opens a call', () => {
  assert.equal(followUpInteractionType(null, LABELS), 'Call');
  assert.equal(followUpInteractionType('', LABELS), 'Call');
  // `other` stores the free text alone; a rep's own note is the same.
  assert.equal(followUpInteractionType('Send the brochure next week', LABELS), 'Call');
  // A label inside a word is not the label.
  assert.equal(followUpInteractionType('Callback later', LABELS), 'Call');
  assert.equal(handoffActionFromNote('Callback later', LABELS), null);
});

const { handoffNoteText, followUpNoteMissing } = await import('../../src/lib/leadHandoffRule.ts');

test('the panel shows the words without the composed pick label, in any language (#3903)', () => {
  assert.equal(handoffNoteText('Call: ask about pricing', LABELS), 'ask about pricing');
  assert.equal(handoffNoteText('Call', LABELS), '');
  assert.equal(handoffNoteText('E-posta atılacak: teklif', LABELS), 'teklif');
  assert.equal(handoffNoteText('Callback later', LABELS), 'Callback later');
  assert.equal(handoffNoteText(null, LABELS), '');
});

test('"other" needs words in both follow-up forms (#3903)', () => {
  assert.equal(followUpNoteMissing('other', '  '), true);
  assert.equal(followUpNoteMissing('other', 'x'), false);
  assert.equal(followUpNoteMissing('call', ''), false);
  assert.equal(followUpNoteMissing(null, ''), false);
});

test('a person closed to hand-offs takes none from a colleague, but may take one onto their own book (#3979)', () => {
  assert.equal(mayReceiveHandoff({ recipientId: 'b', acceptsLeadHandoffs: true, actorId: 'a' }), true);
  assert.equal(mayReceiveHandoff({ recipientId: 'b', acceptsLeadHandoffs: false, actorId: 'a' }), false);
  assert.equal(mayReceiveHandoff({ recipientId: 'b', acceptsLeadHandoffs: false, actorId: 'b' }), true);
});

test('"handed on by me" is the last hand-off, from or by the viewer, of a lead not back with them (#3980)', () => {
  assert.equal(handedOnBy({ fromUserId: 'me', actorId: 'me' }, 'b', 'me'), true);
  assert.equal(handedOnBy({ fromUserId: 'a', actorId: 'me' }, 'b', 'me'), true, 'the dispatcher passed it on');
  assert.equal(handedOnBy({ fromUserId: 'me', actorId: 'admin' }, 'b', 'me'), true, 'taken from me by an admin');
  assert.equal(handedOnBy({ fromUserId: 'b', actorId: 'b' }, 'c', 'me'), false, 'someone else passed it on later');
  assert.equal(handedOnBy({ fromUserId: 'me', actorId: 'me' }, 'me', 'me'), false, 'back with me');
  assert.equal(handedOnBy(null, 'b', 'me'), false);
});
