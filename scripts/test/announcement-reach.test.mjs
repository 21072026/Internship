// Unit tests for the announcement reach rule (#1921, src/lib/announcementReachRule.ts).
//
// Run: node --test --experimental-strip-types scripts/test/announcement-reach.test.mjs
//
// What a reviewer cannot keep in their head: a read count is a total only above
// the floor (below it, it names people), and a count for an announcement older
// than the retention cutoff is withheld, not shown shrunk by the sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANNOUNCEMENT_READ_FLOOR, announcementSentAt, readReach } from '../../src/lib/announcementReachRule.ts';

const cutoff = new Date('2026-05-01T00:00:00Z');
const recent = '2026-10-01T00:00:00Z';

test('a sent announcement with a big enough audience shows read of delivered and the rate', () => {
  assert.deepEqual(readReach({ status: 'SENT', sentAt: recent, delivered: 8, read: 6 }, cutoff), { read: 6, delivered: 8, rate: 75, withheld: null });
  assert.deepEqual(readReach({ status: 'SENT', sentAt: recent, delivered: 8, read: 0 }, null), { read: 0, delivered: 8, rate: 0, withheld: null });
});

test('below the floor the read count is withheld — "1 of 1 read" is one person', () => {
  assert.equal(ANNOUNCEMENT_READ_FLOOR, 5);
  for (const delivered of [0, 1, 4]) {
    assert.deepEqual(readReach({ status: 'SENT', sentAt: recent, delivered, read: delivered }, cutoff), { read: null, delivered, rate: null, withheld: 'small_audience' });
  }
  assert.equal(readReach({ status: 'SENT', sentAt: recent, delivered: 5, read: 1 }, cutoff).withheld, null);
});

test('older than the retention cutoff is withheld, whatever the size; no cutoff keeps it', () => {
  const old = { status: 'SENT', sentAt: '2026-01-01T00:00:00Z', delivered: 50, read: 10 };
  assert.equal(readReach(old, cutoff).withheld, 'pruned');
  assert.equal(readReach(old, null).withheld, null);
});

test('not sent yet (scheduled, sending, canceled) has nothing to report', () => {
  for (const status of ['SCHEDULED', 'SENDING', 'CANCELED']) {
    assert.equal(readReach({ status, sentAt: recent, delivered: 0, read: 0 }, cutoff).withheld, 'not_sent');
  }
});

test('a scheduled announcement went out at its schedule, any other at creation', () => {
  const createdAt = '2026-10-01T00:00:00Z';
  assert.equal(announcementSentAt({ scheduledAt: '2026-10-05T09:00:00Z', createdAt }).toISOString(), '2026-10-05T09:00:00.000Z');
  assert.equal(announcementSentAt({ scheduledAt: null, createdAt }).toISOString(), '2026-10-01T00:00:00.000Z');
});
