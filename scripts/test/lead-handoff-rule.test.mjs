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
