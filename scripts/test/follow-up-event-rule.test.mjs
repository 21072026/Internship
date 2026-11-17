// Unit tests for the follow-up history rule (#3819): which ONE event an edit
// of a record's follow-up makes, and the key that keeps a retried or
// double-clicked write to one row. Both fail silently in the browser — a
// wrong diff writes a misleading line, a wrong key writes two.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpDedupeKey, followUpEventFor } from '../../src/lib/followUpEventRule.ts';

const d = (iso) => new Date(`${iso}T00:00:00.000Z`);
const none = { at: null, note: null };

test('nothing → something is ASSIGNED', () => {
  assert.equal(followUpEventFor(none, { at: d('2026-11-20'), note: 'call' })?.kind, 'ASSIGNED');
  assert.equal(followUpEventFor(none, { at: null, note: 'call' })?.kind, 'ASSIGNED');
});

test('something → nothing is CLEARED, or COMPLETED when the caller says so', () => {
  const before = { at: d('2026-11-20'), note: 'call' };
  assert.equal(followUpEventFor(before, none)?.kind, 'CLEARED');
  assert.equal(followUpEventFor(before, none, { completed: true })?.kind, 'COMPLETED');
});

test('completed only matters for a clear', () => {
  const ev = followUpEventFor({ at: d('2026-11-20'), note: null }, { at: d('2026-11-21'), note: null }, { completed: true });
  assert.equal(ev?.kind, 'CHANGED');
});

test('a moved day or a new note is CHANGED, with both sides', () => {
  const ev = followUpEventFor({ at: d('2026-11-20'), note: 'call' }, { at: d('2026-11-22'), note: 'call' });
  assert.equal(ev?.kind, 'CHANGED');
  assert.deepEqual(ev?.fromAt, d('2026-11-20'));
  assert.deepEqual(ev?.toAt, d('2026-11-22'));
  assert.equal(followUpEventFor({ at: null, note: 'a' }, { at: null, note: 'b' })?.kind, 'CHANGED');
});

test('no change is no event — same day at another hour, note only re-spaced', () => {
  assert.equal(followUpEventFor({ at: d('2026-11-20'), note: 'call' }, { at: new Date('2026-11-20T15:00:00Z'), note: ' call ' }), null);
  assert.equal(followUpEventFor(none, { at: null, note: '   ' }), null);
});

test('the key is stable for a racing copy and differs once the record moved on', () => {
  const ev = followUpEventFor(none, { at: d('2026-11-20'), note: 'call' });
  const read = new Date('2026-11-17T10:00:00.123Z');
  assert.equal(followUpDedupeKey(ev, read), followUpDedupeKey(ev, new Date(read)));
  assert.notEqual(followUpDedupeKey(ev, read), followUpDedupeKey(ev, new Date('2026-11-17T10:05:00Z')));
  assert.ok(followUpDedupeKey(ev, read).startsWith('followup:ASSIGNED:'));
});

test('a hand-off key names both owners and fits the column', () => {
  const facts = { kind: 'HANDED_OFF', fromAt: null, toAt: d('2026-11-20'), fromNote: null, toNote: 'x' };
  const read = new Date('2026-11-17T10:00:00Z');
  const a = followUpDedupeKey(facts, read, { from: 'u1', to: 'u2' });
  assert.notEqual(a, followUpDedupeKey(facts, read, { from: 'u1', to: 'u3' }));
  assert.ok(followUpDedupeKey(facts, read, { from: 'x'.repeat(200), to: 'y'.repeat(200) }).length <= 191);
});
