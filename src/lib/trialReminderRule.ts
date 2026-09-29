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
 * The key of the MARKETING preset's "trial ran out" stage — where the expiry
 * sweep parks an elapsed trial (#2417). Named here for the same reason as
 * TRIAL_ACTIVE_STAGE_KEY: `planTrialEndChange()` below compares against it,
 * and lib/programTemplates.ts re-exports it beside its preset.
 */
export const TRIAL_EXPIRED_STAGE_KEY = 'TRIAL_EXPIRED';

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

// ── A PERSON SETS OR MOVES THE TRIAL END (#2553) ────────────────────────────
//
// `trialWindowFor()` above is what a STAGE write stamps, and it never
// overwrites a window — a board drag must not be able to extend a trial.
// Extending one is a real sales move, so it is its own explicit, audited write
// (PATCH /api/mentorship/[id]/trial), and this is its rule.
//
// THE CLAIM ROWS ARE LEFT ALONE. A `TrialReminder` row answers "has this mark
// been handled for this record?", and that stays true across an extension: a
// trial moved from 3 days out to 20 days out does not get its 7-day or 3-day
// mail a second time. Whatever the new window still has ahead of it — a mark
// nobody has claimed yet — fires on its day as usual, because the selector only
// ever skips thresholds that ARE claimed. Deleting the claims instead would
// mail the same owner twice about the same record, which is exactly what the
// claim-first design exists to prevent (see the TrialReminder model). The
// price, stated plainly: a record whose 0-day mail already went out gets no
// last-day mail in its extended window. The attention queue still lists it
// when it runs out again (#2418), so it is not lost in silence.

/** Anything that may carry a trial end: a Date from Prisma, or a JSON string on the client. */
export type TrialEndValue = Date | string | null | undefined;

function asDate(value: TrialEndValue): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A record that says "trial running" and has no end date (#2553).
 *
 * Such a record is invisible to the whole trial machinery — no reminder is ever
 * due for it (`selectDueTrialReminders` skips a null end) and the expiry sweep
 * never moves it — so it would run silently forever. The attention queue lists
 * it as `trial_no_end_date`, and the board card and the record show a "date
 * missing" badge, all from this one predicate, until somebody enters the date.
 */
export function isTrialMissingEndDate(record: {
  pipelineStatus: string | null | undefined;
  trialEndsAt: TrialEndValue;
}): boolean {
  return record.pipelineStatus === TRIAL_ACTIVE_STAGE_KEY && asDate(record.trialEndsAt) === null;
}

/** The stages in which a trial end may be set by hand: a running trial, or one that ran out. */
export function isTrialEndEditableStage(pipelineStatus: string | null | undefined): boolean {
  return pipelineStatus === TRIAL_ACTIVE_STAGE_KEY || pipelineStatus === TRIAL_EXPIRED_STAGE_KEY;
}

/**
 * The trial-end day a person typed: `YYYY-MM-DD`, stored as midnight UTC — a
 * DAY, compared by UTC day like every other trial date in this module. A real
 * calendar date is required (`2026-02-30` is refused, not rolled into March).
 */
export function parseTrialEndDate(input: unknown): Date | null {
  if (typeof input !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000 || year > 2100) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    return null;
  }
  return value;
}

export type TrialEndChangeError = 'invalid_date' | 'not_in_trial' | 'in_the_past';

export type TrialEndChangePlan =
  | { ok: false; error: TrialEndChangeError }
  /** Nothing to write: the record already ends on that UTC day. */
  | { ok: true; changed: false }
  | {
      ok: true;
      changed: true;
      trialEndsAt: Date;
      /**
       * The record sits in TRIAL_EXPIRED and the new end is today or later, so
       * it goes back to TRIAL_ACTIVE — as a HUMAN stage move (StatusChange +
       * emitStageChange). The never-move-back rule of #2451 binds the machine
       * writers only; a person extending a trial is exactly the move it leaves
       * to people.
       */
      reopen: boolean;
    };

/**
 * What setting a record's trial end to `newEndsAt` means (#2553). Pure — the
 * clock is the caller's.
 *
 *   * only a record in TRIAL_ACTIVE or TRIAL_EXPIRED has a trial end worth
 *     setting; anywhere else nothing reads the date (`not_in_trial`);
 *   * the new end must be today or later, by UTC day. A past date is not an
 *     extension — ending a trial is a stage move, and a past date typed here
 *     would only be swept into TRIAL_EXPIRED on the next tick (`in_the_past`);
 *   * the same UTC day the record already ends on is a no-op, not a write;
 *   * shortening is allowed (a correction is a correction) — the claim rows
 *     still guarantee that no mark is mailed twice.
 */
export function planTrialEndChange({
  pipelineStatus,
  currentEndsAt,
  newEndsAt,
  now,
}: {
  pipelineStatus: string | null | undefined;
  currentEndsAt: TrialEndValue;
  newEndsAt: Date | null;
  now: Date;
}): TrialEndChangePlan {
  if (!newEndsAt || Number.isNaN(newEndsAt.getTime())) return { ok: false, error: 'invalid_date' };
  if (!isTrialEndEditableStage(pipelineStatus)) return { ok: false, error: 'not_in_trial' };
  if (daysUntilUtcDay(newEndsAt, now) < 0) return { ok: false, error: 'in_the_past' };
  const current = asDate(currentEndsAt);
  if (current && utcDayNumber(current) === utcDayNumber(newEndsAt)) return { ok: true, changed: false };
  return {
    ok: true,
    changed: true,
    trialEndsAt: new Date(newEndsAt.getTime()),
    reopen: pipelineStatus === TRIAL_EXPIRED_STAGE_KEY,
  };
}
