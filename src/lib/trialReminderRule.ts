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
//
// ── WHERE A TRIAL WINDOW COMES FROM (#2551) ─────────────────────────────────
//
// The ladder above only ever sees records that HAVE a `trialEndsAt`, so the
// other half of the rule is the one that writes it: `trialWindowFor()` below.
// Every path that writes `pipelineStatus` spreads its answer into the same
// `data` block that moves the stage — the board, the backdatable status-change
// endpoint, the bulk advance, the marketing import (create and update) — and
// the mentor transfer copies the window it already has. The stamp is NOT made
// in `emitStageChange()`: that runs after the write, returns early on
// from === to, and the import deliberately never calls it (stand-in leads must
// not be notified), so a stamp there would miss exactly the imported trials.
// scripts/test/trial-window-writers.test.mjs is the ratchet that holds every
// stage writer to this.

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

/**
 * The key of the MARKETING preset's "trial running" stage. Named here, in the
 * dependency-free rule, so `trialWindowFor()` can compare against it without an
 * import; lib/programTemplates.ts re-exports it next to the preset that ships
 * it, so there is still exactly one spelling in the tree.
 */
export const TRIAL_ACTIVE_STAGE_KEY = 'TRIAL_ACTIVE';

/**
 * The code default of the `trialLengthDays` org setting (src/lib/settings.ts):
 * the free-use period of a trial. 30 days, which is what the product being
 * sold actually grants (the SaleVali trial; its separate decision window after
 * the free period is #2572, not this number).
 */
export const DEFAULT_TRIAL_LENGTH_DAYS = 30;

/** Upper bound for `trialLengthDays`: a year is already not a trial. */
export const MAX_TRIAL_LENGTH_DAYS = 365;

/**
 * The `trialLengthDays` setting string as a number of days.
 *
 * Anything that is not a whole number in 1..MAX falls back to the default
 * rather than to 0: a trial of zero days would be stamped as already over and
 * swept into TRIAL_EXPIRED on the next tick, so a blank or corrupted setting row
 * must not be able to expire every new trial.
 */
export function parseTrialLengthDays(raw: string | null | undefined): number {
  const value = (raw ?? '').trim();
  if (!/^\d{1,4}$/.test(value)) return DEFAULT_TRIAL_LENGTH_DAYS;
  const days = Number(value);
  return days >= 1 && days <= MAX_TRIAL_LENGTH_DAYS ? days : DEFAULT_TRIAL_LENGTH_DAYS;
}

/** The trial dates a record already carries, if any. */
export interface ExistingTrialWindow {
  trialStartedAt?: Date | null;
  trialEndsAt?: Date | null;
}

export interface TrialWindowInput {
  /** The stage the write moves the record INTO (or creates it at). */
  toStage: string | null | undefined;
  /** When the record enters that stage — the write's own clock. */
  enteredAt: Date;
  /** What the record already carries; null/undefined for a record being created. */
  existing?: ExistingTrialWindow | null;
  /** The resolved `trialLengthDays` setting. Invalid values fall back to the default. */
  lengthDays: number;
}

/** Only the fields that must be written; `{}` means "write nothing". */
export interface TrialWindowData {
  trialStartedAt?: Date;
  trialEndsAt?: Date;
}

function isDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * The trial dates a stage write must add to its `data` block (#2551).
 *
 * Returns something only when the target stage is TRIAL_ACTIVE and the record
 * has no trial end yet, and it NEVER returns a field the record already has:
 *
 *   * a record that re-enters TRIAL_ACTIVE (moved out by mistake and back, or
 *     back from TRIAL_EXPIRED) keeps its FIRST window — the trial end is agreed
 *     with the customer, and a board drag must not be able to extend it;
 *   * a record with a start but no end (set by hand) gets only the end,
 *     counted from its own start — the date somebody already wrote wins;
 *   * a record with an end but no start is left alone: inventing a start would
 *     claim a date nobody recorded.
 *
 * Pure: no clock (`enteredAt` is the caller's), no database, no setting read.
 * The result is meant to be spread — `{ pipelineStatus, ...trialWindowFor(…) }`.
 */
export function trialWindowFor({ toStage, enteredAt, existing, lengthDays }: TrialWindowInput): TrialWindowData {
  if (toStage !== TRIAL_ACTIVE_STAGE_KEY) return {};
  if (isDate(existing?.trialEndsAt)) return {};
  const days =
    Number.isInteger(lengthDays) && lengthDays >= 1 && lengthDays <= MAX_TRIAL_LENGTH_DAYS
      ? lengthDays
      : DEFAULT_TRIAL_LENGTH_DAYS;
  const start = existing?.trialStartedAt;
  if (isDate(start)) return { trialEndsAt: new Date(start.getTime() + days * MS_PER_DAY) };
  if (!isDate(enteredAt)) return {};
  return {
    trialStartedAt: new Date(enteredAt.getTime()),
    trialEndsAt: new Date(enteredAt.getTime() + days * MS_PER_DAY),
  };
}

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
