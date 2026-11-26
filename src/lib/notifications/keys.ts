// The keys a routed notification hands to the job queue (#3950). One
// delivery (its ledger `dedupeKey`) makes TWO keyed jobs on the e-mail path:
// the router's `notification.email` job, and the `email.send` the job queues
// through sendEmail(). `Job.idempotencyKey` is unique across ALL jobs, so the
// two must never be the same string: the mail used to reuse the first one's
// key, collided with it, was "deduplicated" against it and never sent — while
// the ledger said SENT. Dependency-free: e2e/notification-keys.unit.spec.ts.

/** The `notification.email` job of one delivery. The e-mail job reads its ledger key back from it. */
export function notificationJobKey(dedupeKey: string): string {
  return `notify:${dedupeKey}`;
}

/** The ledger key a `notification.email` job carries, or null for one that was not routed. */
export function ledgerKeyOfJob(idempotencyKey: string | null | undefined): string | null {
  return idempotencyKey && idempotencyKey.startsWith('notify:') ? idempotencyKey.slice('notify:'.length) : null;
}

/** The one mail of that delivery (sendEmail's `dedupeKey`, the `email.send` job's key). */
export function notificationMailKey(dedupeKey: string): string {
  return `notify-mail:${dedupeKey}`;
}
