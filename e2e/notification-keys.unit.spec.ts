import { test, expect } from '@playwright/test';
import { createMemoryQueueStore, enqueue } from '@/lib/jobs/queue';
import { ledgerKeyOfJob, notificationJobKey, notificationMailKey } from '@/lib/notifications/keys';

// The two keyed jobs of one notification mail (#3950, src/lib/notifications/keys.ts):
// the router's `notification.email` job and the `email.send` it queues. They
// used to share one key; the mail collided with its own job and was never sent.

test('a delivery\'s job key and mail key are different strings; the job key reads back to the ledger key', { tag: '@smoke' }, () => {
  const ledger = 'lead-handoff:rel1:user1:1764150000000';
  expect(notificationJobKey(ledger)).not.toBe(notificationMailKey(ledger));
  expect(ledgerKeyOfJob(notificationJobKey(ledger))).toBe(ledger);
  // The mail key is never mistaken for a routed job's key.
  expect(ledgerKeyOfJob(notificationMailKey(ledger))).toBeNull();
  expect(ledgerKeyOfJob(null)).toBeNull();
});

test('the job and its mail are two rows on one queue', { tag: '@smoke' }, async () => {
  const store = createMemoryQueueStore();
  const ledger = 'lead-handoff:rel1:user1:1764150000000';
  await enqueue('notification.email', { eventKey: 'lead.handedOff' } as never, { store, idempotencyKey: notificationJobKey(ledger) });
  await enqueue('email.send', {} as never, { store, idempotencyKey: notificationMailKey(ledger) });
  expect(store.jobs.map((j) => j.name).sort()).toEqual(['email.send', 'notification.email']);
  // A retried mail of the same delivery is still one mail.
  await enqueue('email.send', {} as never, { store, idempotencyKey: notificationMailKey(ledger) });
  expect(store.jobs).toHaveLength(2);
});
