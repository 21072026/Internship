// Unit tests for "contact or attempt?" (#3902).
//
// The rule is tiny, but two mistakes in it are invisible from a browser: a type
// that may carry NOT_REACHED drifting (an e-mail "not reached" would hide a sent
// mail from last contact), and the contact filter matching attempts (an
// unanswered call silencing "no recent contact").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERACTION_OUTCOMES,
  ATTEMPTABLE_TYPES,
  canBeAttempt,
  isAttempt,
  outcomeAllowed,
  CONTACT_INTERACTION_WHERE,
  ATTEMPT_INTERACTION_WHERE,
} from '../../src/lib/interactionOutcome.ts';

test('only a Call or a WhatsApp can be unanswered', () => {
  assert.deepEqual([...ATTEMPTABLE_TYPES], ['Call', 'WhatsApp']);
  for (const t of ['Call', 'WhatsApp']) assert.equal(canBeAttempt(t), true);
  for (const t of ['Email', 'Meeting', 'Feedback', '', 'call']) assert.equal(canBeAttempt(t), false);
});

test('REACHED is allowed on every type, NOT_REACHED only on attemptable ones', () => {
  for (const t of ['Call', 'WhatsApp', 'Email', 'Meeting', 'Feedback']) {
    assert.equal(outcomeAllowed(t, 'REACHED'), true);
    assert.equal(outcomeAllowed(t, undefined), true);
    assert.equal(outcomeAllowed(t, null), true);
  }
  assert.equal(outcomeAllowed('Call', 'NOT_REACHED'), true);
  assert.equal(outcomeAllowed('WhatsApp', 'NOT_REACHED'), true);
  assert.equal(outcomeAllowed('Email', 'NOT_REACHED'), false);
  assert.equal(outcomeAllowed('Meeting', 'NOT_REACHED'), false);
});

test('a row is an attempt only when it says NOT_REACHED; a pre-#3902 row is contact', () => {
  assert.equal(isAttempt({ outcome: 'NOT_REACHED' }), true);
  assert.equal(isAttempt({ outcome: 'REACHED' }), false);
  assert.equal(isAttempt({ outcome: null }), false);
  assert.equal(isAttempt({}), false);
});

test('the contact and attempt filters partition the outcomes', () => {
  assert.deepEqual([...INTERACTION_OUTCOMES], ['REACHED', 'NOT_REACHED']);
  assert.deepEqual(CONTACT_INTERACTION_WHERE, { outcome: 'REACHED' });
  assert.deepEqual(ATTEMPT_INTERACTION_WHERE, { outcome: 'NOT_REACHED' });
  assert.notEqual(CONTACT_INTERACTION_WHERE.outcome, ATTEMPT_INTERACTION_WHERE.outcome);
});
