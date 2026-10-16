// One in-process flag (#2953): "the relay rejected our credentials since the
// operator alerts were last evaluated". Set by every SMTP path that sees the
// rejection — an inline send in `emailService.ts`, a queued one in
// `mailOutbox.ts` — and taken by `evaluateMailOps()` (src/lib/mailOpsAlert.ts),
// which the drain route runs after every tick.
//
// A separate module with no imports so that both senders can set it without
// importing the alert module (which imports emailService, which imports the
// outbox): the import graph stays one-way. Per process on purpose: each
// replica reports what it saw, and the alert's hourly key makes two reports
// one mail.

let authRejectedAt: number | null = null;

export function noteRelayAuthRejected(now: number = Date.now()): void {
  authRejectedAt = now;
}

/** True when a rejection was noted since the last take; clears the flag. */
export function takeRelayAuthRejected(): boolean {
  const seen = authRejectedAt !== null;
  authRejectedAt = null;
  return seen;
}
