// The Notification retention RULE (#1646) — deliberately Prisma-free.
//
// The mechanism (the registry, the batching, the one nightly schedule) is
// #1678's `retentionPrune.ts`; the query that applies this rule is the
// `notification` entry in `retentionEntries.ts`. What lives here is the part
// worth arguing about — which rows may be deleted, and how old is old enough —
// split out for the same reason the mechanism was: it can then be unit-tested
// without a database (`e2e/notification-retention.unit.spec.ts`), and the two
// safety rails of this feature are exactly the kind of thing that decays when
// nothing tests it.

/**
 * The floor no setting can go under.
 *
 * `notificationRetentionDays` is on the admin settings form, which means a
 * number typed in a hurry reaches the nightly job unreviewed. Thirty days is the
 * rail that makes the worst typo survivable: whatever the form says, this
 * morning's bell — and last month's — is still there tomorrow. It is a floor,
 * not a default; the default is 180 (`SETTING_DEFAULTS`).
 */
export const NOTIFICATION_RETENTION_FLOOR_DAYS = 30;

/**
 * Notification types that age never removes.
 *
 * Most notifications are a convenience: the fact behind them lives in a row
 * somewhere else (the message, the meeting, the offer) and the bell entry is a
 * pointer to it. These are not. For each one the notification IS the record that
 * we told the person something, and there is no second copy that outlives it:
 *
 *   - `retention.confirm` — the GDPR re-consent prompt (`src/lib/retention.ts`).
 *     Its link carries the renewal token, so an unanswered one is still live
 *     work, and the e-mail copy of the same notice is itself pruned at 90 days
 *     (`EMAIL_LOG_RETENTION_DAYS`). `User.retentionReminderSentAt` records a date
 *     and nothing else — it cannot show WHAT the person was asked. Deleting the
 *     row would leave a consent request we can no longer evidence.
 *   - `impersonation.accessed` / `impersonation.accessedWithReason` — the
 *     transparency notice that an administrator entered somebody's account.
 *     ActivityLog holds the operator-side record (`impersonate.start`), but that
 *     is admin-only: this row is the ACCOUNT HOLDER'S only copy, and a
 *     transparency notice its subject can no longer see has stopped being one.
 *
 * Deliberately NOT here: the `security.*` notices. Those mirror an admin action
 * the security ledger keeps for a year under its own longer window and its own
 * reason, and the user-facing copy is informational — it records no right
 * exercised and no consent given. Widening this list past the rows that are
 * genuinely sole evidence would quietly turn the window off.
 */
export const RETAINED_NOTIFICATION_TYPES = [
  'retention.confirm',
  'impersonation.accessed',
  'impersonation.accessedWithReason',
] as const;

/**
 * The cutoff one org's window produces, or `null` for "keep forever".
 *
 * `0` (and any negative) means keep forever: that is the pre-#1646 behaviour,
 * and an operator choosing it should be choosing it rather than falling into it.
 * Anything positive is raised to `NOTIFICATION_RETENTION_FLOOR_DAYS`, and a
 * value that is not a usable number is treated as "keep forever" rather than as
 * zero days — the safe direction for a corrupted setting row is to delete less.
 */
export function notificationRetentionCutoff(now: Date, retentionDays: number): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  const days = Math.max(Math.floor(retentionDays), NOTIFICATION_RETENTION_FLOOR_DAYS);
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
