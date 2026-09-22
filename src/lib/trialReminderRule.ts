// "Which trials need a reminder today?" — one rule, one implementation (#2413,
// story #2392).
//
// A trial in the MARKETING funnel never auto-renews: a trial that runs out
// while nobody is looking is a customer lost in silence. So the owner is
// written to three times on the way down — seven days out, three days out, and
// on the last day — and this module is the whole decision about who that is.
//
// ── THE COMPARISON IS BY CALENDAR DAY, IN UTC ───────────────────────────────
//
// The obvious implementation compares timestamps (`trialEndsAt < now + 7d`),
// and it is wrong in the way that is hardest to notice: a trial that ends at
// 09:00 is 6.96 days away when the 08:00 tick runs seven days earlier, so the
// seven-day mail never goes out — and the SAME trial is 7.04 days away for a
// tick an hour earlier, so it does. Whether a customer hears from us would
// depend on what time of day somebody happened to start a trial. The existing
// sweeps in this repo compare raw timestamps for exactly this reason and miss
// what ends a few hours before the tick (`expiresAt: { lt: now }` in
// lib/offerNotify.ts; `stageDeadline: { lt: now }` in services/emailService.ts).
//
// So the unit is the CALENDAR DAY: the difference between the UTC day
// `trialEndsAt` falls on and the UTC day `now` falls on. A trial ending seven
// calendar days from today is due for its seven-day reminder whatever hour the
// job ticks at, and it is due exactly once, because the next tick is a day
// later and the difference has moved on.
//
// UTC, not the tenant's timezone, and not the recipient's. The reminder is a
// daily cron running on one clock for every tenant, the date the mail names is
// rendered in the reader's own locale/zone by the mail layer, and a per-user
// day boundary would mean the same trial is "3 days out" for one reader and "4"
// for another on the same tick. One clock, stated here, is the cheaper truth.
//
// ── EXACT MATCH, NOT "AT MOST" ──────────────────────────────────────────────
//
// A threshold fires on the ONE day the difference equals it, never on a later
// day that is merely past it. Two consequences, both deliberate:
//
//   * the subject line is always true. "Ends in 7 days" sent on the fifth day
//     out — which is what a catch-up rule would do after a missed tick — is a
//     mail that lies about the one fact it exists to carry;
//   * a tick that does not run loses that one threshold rather than
//     re-sending everything it missed at once. That is the same trade the claim
//     rows make (claim first, then send: see the TrialReminder model), and it
//     is affordable here precisely because the thresholds are a LADDER — a lost
//     7-day mail is still followed by the 3-day and the 0-day one, so the trial
//     is not lost in silence, which is the thing story #2392 is about.
//
// It is also what makes the claim rows safely prunable: once a trial has
// elapsed the difference is negative and can never equal a threshold again, so
// deleting an old claim row cannot resurrect a reminder for a trial that is
// long over (src/lib/retentionEntries.ts).
//
// This module is the RULE and is deliberately dependency-free (no `@/` imports,
// no Prisma types) so a plain `node --experimental-strip-types` test can import
// it — scripts/test/trial-reminder-rule.test.mjs. The queries that feed it live
// in lib/trialReminders.ts, which re-exports everything here.

/**
 * Days-remaining marks at which the owner is written to, highest first.
 *
 * Three and no more, for the same reason the dormant check-in stops at two
 * (docs/dormant-first-contacts.md): the reputation of the sending domain is
 * spent by the fourth mail nobody asked for. 7 is far enough out to act on, 3
 * is the nudge, 0 is the last day — after that the trial has elapsed and the
 * record belongs in the attention queue (#2418), not in the mailbox.
 */
export const TRIAL_REMINDER_THRESHOLDS = [7, 3, 0] as const;

/** One funnel record, as much of it as the rule needs. */
export interface TrialReminderCandidate {
  /** MentorshipRelation id — the funnel record (see the data-model note in CLAUDE.md). */
  id: string;
  /** The contractual end of the trial. Null means "no trial", never "ends today". */
  trialEndsAt: Date | null | undefined;
  /** Thresholds already claimed for this record (TrialReminder rows). */
  sentThresholds: readonly number[];
}

/** One reminder that is due: which record, which mark, and how far out it is. */
export interface DueTrialReminder {
  relationId: string;
  threshold: number;
  /** Whole calendar days from today (UTC) to the trial's last day. Equals `threshold`. */
  daysRemaining: number;
}

export interface SelectDueTrialRemindersOptions {
  /** Injected clock. Required: a rule that reads the wall clock cannot be tested. */
  now: Date;
  /** Override the ladder; defaults to TRIAL_REMINDER_THRESHOLDS. */
  thresholds?: readonly number[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The UTC calendar day a moment falls on, as a day number.
 *
 * Built from the UTC *date parts* rather than from `getTime() / MS_PER_DAY` so
 * the answer cannot depend on the host's timezone, and so a value stored as a
 * MySQL `DATETIME` with a zero time reads as its own day rather than the one
 * before it.
 */
export function utcDayNumber(at: Date): number {
  return Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) / MS_PER_DAY);
}

/**
 * Whole calendar days (UTC) from `now` to `endsAt`: 7 when the trial ends a
 * week from today, 0 on its last day, negative once it has elapsed.
 */
export function daysUntilUtcDay(endsAt: Date, now: Date): number {
  return utcDayNumber(endsAt) - utcDayNumber(now);
}

/** The ladder, de-duplicated and highest first, so the output order is stable. */
function normalizeThresholds(thresholds: readonly number[]): number[] {
  return [...new Set(thresholds.filter((t) => Number.isInteger(t)))].sort((a, b) => b - a);
}

/**
 * Every (record, threshold) pair that is due on this tick.
 *
 * At most ONE pair per record: the thresholds are distinct and the match is
 * exact, so a record cannot be due for two marks on the same day. Records with
 * no `trialEndsAt`, and thresholds already claimed, are skipped. Pure — no
 * clock, no database, no side effects.
 */
export function selectDueTrialReminders(
  candidates: readonly TrialReminderCandidate[],
  { now, thresholds = TRIAL_REMINDER_THRESHOLDS }: SelectDueTrialRemindersOptions,
): DueTrialReminder[] {
  const ladder = normalizeThresholds(thresholds);
  const due: DueTrialReminder[] = [];

  for (const candidate of candidates) {
    const endsAt = candidate.trialEndsAt;
    // A record with no trial date is not "ending today" — it has no trial.
    if (!endsAt || Number.isNaN(endsAt.getTime())) continue;

    const daysRemaining = daysUntilUtcDay(endsAt, now);
    const threshold = ladder.find((t) => t === daysRemaining);
    if (threshold === undefined) continue;
    if (candidate.sentThresholds.includes(threshold)) continue;

    due.push({ relationId: candidate.id, threshold, daysRemaining });
  }

  return due;
}
