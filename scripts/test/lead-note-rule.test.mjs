// Unit tests for the free note on a sales record (#3978, src/lib/leadNoteRule.ts):
// its shape, who may add one, who hears about it, and the key that keeps a
// double click to one row while the same words a minute later are a new note.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_NOTE_MAX, leadNoteDedupeKey, mayAddLeadNote, noteNotifiesOwner, parseLeadNote } from '../../src/lib/leadNoteRule.ts';
import { FOLLOW_UP_EVENT_KINDS } from '../../src/lib/followUpEventRule.ts';

test('a note is 1…280 characters after trimming, line breaks kept', () => {
  assert.deepEqual(parseLeadNote('  Called back\nwants the offer  '), { ok: true, text: 'Called back\nwants the offer' });
  assert.deepEqual(parseLeadNote('   '), { ok: false, code: 'empty' });
  assert.deepEqual(parseLeadNote(null), { ok: false, code: 'empty' });
  assert.deepEqual(parseLeadNote(42), { ok: false, code: 'empty' });
  assert.equal(parseLeadNote('x'.repeat(LEAD_NOTE_MAX)).ok, true);
  assert.deepEqual(parseLeadNote('x'.repeat(LEAD_NOTE_MAX + 1)), { ok: false, code: 'too_long' });
  // Counted in characters, not UTF-16 units: 280 emoji are a valid note.
  assert.equal(parseLeadNote('😀'.repeat(LEAD_NOTE_MAX)).ok, true);
  assert.equal(LEAD_NOTE_MAX, 280, 'the column is FollowUpEvent.toNote VarChar(280)');
});

test('whoever may work the record, or owned it before, may add a note; nobody else', () => {
  assert.equal(mayAddLeadNote({ writable: true, previousOwner: false }), true);
  assert.equal(mayAddLeadNote({ writable: false, previousOwner: true }), true);
  assert.equal(mayAddLeadNote({ writable: false, previousOwner: false }), false);
});

test('the owner hears about a colleague\'s note, never about their own', () => {
  assert.equal(noteNotifiesOwner({ authorId: 'a', ownerId: 'b' }), true);
  assert.equal(noteNotifiesOwner({ authorId: 'b', ownerId: 'b' }), false);
});

test('the dedupe key: one row per author, text and minute', () => {
  const t0 = new Date('2026-11-27T10:00:05Z');
  const t1 = new Date('2026-11-27T10:00:55Z');
  const t2 = new Date('2026-11-27T10:01:05Z');
  assert.equal(leadNoteDedupeKey('u1', 'hello', t0), leadNoteDedupeKey('u1', 'hello', t1));
  assert.notEqual(leadNoteDedupeKey('u1', 'hello', t0), leadNoteDedupeKey('u1', 'hello', t2));
  assert.notEqual(leadNoteDedupeKey('u1', 'hello', t0), leadNoteDedupeKey('u2', 'hello', t0));
  assert.notEqual(leadNoteDedupeKey('u1', 'hello', t0), leadNoteDedupeKey('u1', 'hello!', t0));
  assert.ok(leadNoteDedupeKey('c'.repeat(40), 'x'.repeat(280), t0).length <= 191, 'fits FollowUpEvent.dedupeKey');
});

test('NOTE is a history kind', () => {
  assert.ok(FOLLOW_UP_EVENT_KINDS.includes('NOTE'));
});
