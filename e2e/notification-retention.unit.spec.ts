import { test, expect } from '@playwright/test';
import {
  NOTIFICATION_RETENTION_FLOOR_DAYS,
  RETAINED_NOTIFICATION_TYPES,
  notificationRetentionCutoff,
} from '@/lib/notificationRetention';

// The Notification retention RULE (#1646), tested without a database.
//
// The nightly job that applies it is one entry in #1678's registry and is
// covered by the mechanism's own specs. What is tested here is the part an
// operator can change from a form, and the two rails that stop them changing it
// into a mistake:
//
//   1. nothing younger than 30 days is ever deleted, whatever the setting says;
//   2. `0` means keep forever, not "delete everything".
//
// (The third rail — an unread row is never deleted — is a `where` clause in the
// entry, exercised against a real database, not a decision this module makes.)

const NOW = new Date('2026-09-07T03:20:00.000Z');

function daysBefore(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

test('the configured window becomes the cutoff', () => {
  expect(notificationRetentionCutoff(NOW, 180)?.toISOString()).toBe(daysBefore(180));
  expect(notificationRetentionCutoff(NOW, 90)?.toISOString()).toBe(daysBefore(90));
});

test('a window under the floor is raised to it — this morning\'s bell survives any setting', () => {
  expect(notificationRetentionCutoff(NOW, 1)?.toISOString()).toBe(daysBefore(NOTIFICATION_RETENTION_FLOOR_DAYS));
  expect(notificationRetentionCutoff(NOW, 29)?.toISOString()).toBe(daysBefore(NOTIFICATION_RETENTION_FLOOR_DAYS));
  // Exactly the floor is the floor, and one day over it is honoured.
  expect(notificationRetentionCutoff(NOW, 30)?.toISOString()).toBe(daysBefore(30));
  expect(notificationRetentionCutoff(NOW, 31)?.toISOString()).toBe(daysBefore(31));
});

test('0 means keep forever, and so does anything unusable', () => {
  expect(notificationRetentionCutoff(NOW, 0)).toBeNull();
  expect(notificationRetentionCutoff(NOW, -5)).toBeNull();
  // A corrupted setting row parses to NaN; deleting less is the safe direction.
  expect(notificationRetentionCutoff(NOW, Number.NaN)).toBeNull();
  expect(notificationRetentionCutoff(NOW, Number.POSITIVE_INFINITY)).toBeNull();
});

test('a fractional window is floored rather than rounded up', () => {
  expect(notificationRetentionCutoff(NOW, 90.9)?.toISOString()).toBe(daysBefore(90));
});

test('the consent and impersonation notices are excluded from the sweep', () => {
  // Named individually rather than by count: this list is the evidence
  // exception, and a name silently dropping out of it is the regression.
  expect([...RETAINED_NOTIFICATION_TYPES]).toEqual([
    'retention.confirm',
    'impersonation.accessed',
    'impersonation.accessedWithReason',
  ]);
});
