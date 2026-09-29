// "What is the next step on this record, and when?" — one rule (#2563, story
// #2397).
//
// The basic CRM loop: an owner writes "call Thursday about pricing" on a
// record; on Thursday they are reminded; from Friday on the record sits in the
// attention queue until somebody moves the date or clears it. Three columns on
// MentorshipRelation carry it (`nextActionAt`, `nextActionNote`,
// `nextActionRemindedAt`, see the schema comment) and this module is the whole
// decision about what they mean.
//
// ── INDEPENDENT OF THE STAGE SLA ────────────────────────────────────────────
//
// `stageDeadline` is an internal service level that src/lib/stageSla.ts
// rewrites on every stage change. A follow-up date is the opposite kind of
// date: a person set it, and moving the record to another stage must not move
// or erase it. Nothing in the stage write paths touches these columns, and
// nothing here reads the stage.
//
// ── BY CALENDAR DAY, IN UTC ─────────────────────────────────────────────────
//
// The same unit trialReminderRule.ts argues for at length: the value is a DAY
// the owner picked ("Thursday"), stored as midnight UTC, and every comparison
// is between UTC day indexes. A raw timestamp comparison would make "due" depend
// on what hour the daily tick runs.
//
//   * due (reminder):  the day has come   — day(nextActionAt) <= day(now)
//   * overdue (queue): the day has passed — day(nextActionAt) <  day(now)
//
// So a record appears in the attention queue as `next_action_due` the day
// AFTER its reminder, which is the acceptance criterion: remind on the day,
// flag from the day after.
//
// ── ONCE PER DATE, WITH CATCH-UP ────────────────────────────────────────────
//
// Unlike the trial ladder, which fires on an EXACT day and lets a missed tick
// lose one rung, a follow-up has only ONE reminder — lose it and the owner is
// never told. So "due" is "on or before today and not yet reminded for this
// date": a tick that did not run is caught up by the next one. `remindedAt` is
// the guard, claimed conditionally before anything is sent; any write that
// MOVES the date clears it (`nextActionPatch`), so a new date reminds again,
// while editing only the note does not re-arm a reminder already sent today.
//
// Dependency-free on purpose (no `@/` imports, no Prisma types) so
// scripts/test/next-action-rule.test.mjs can import it under plain
// `node --experimental-strip-types`.

/** The note column is `VARCHAR(280)` — one line, not a second notes panel. */
export const NEXT_ACTION_NOTE_MAX = 280;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since the epoch of the UTC calendar day `d` falls on. */
export function utcDayIndex(d: Date | number): number {
  const ms = typeof d === 'number' ? d : d.getTime();
  return Math.floor(ms / DAY_MS);
}

/** Midnight UTC of the day AFTER `now` — the exclusive upper bound of "due". */
export function nextActionDueBefore(now: Date | number): Date {
  return new Date((utcDayIndex(now) + 1) * DAY_MS);
}

/** Midnight UTC of `now`'s own day — the exclusive upper bound of "overdue". */
export function nextActionOverdueBefore(now: Date | number): Date {
  return new Date(utcDayIndex(now) * DAY_MS);
}

export type ParsedNextActionDate =
  | { ok: true; value: Date | null }
  | { ok: false; error: 'invalid_date' };

/**
 * Read the date an editor sent: `YYYY-MM-DD` (what `<input type="date">`
 * produces), or null / '' to clear it.
 *
 * Date-only on purpose. A full timestamp would carry the sender's clock into a
 * value whose meaning is a calendar day, and "Thursday" typed in Berlin at
 * 00:30 would land on Wednesday in UTC. A real calendar date is required —
 * `2026-02-30` is refused rather than rolled over into March.
 */
export function parseNextActionDate(input: unknown): ParsedNextActionDate {
  if (input === null || input === undefined || input === '') return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: 'invalid_date' };
  const m = DATE_ONLY.exec(input.trim());
  if (!m) return { ok: false, error: 'invalid_date' };
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000 || year > 2100) return { ok: false, error: 'invalid_date' };
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    return { ok: false, error: 'invalid_date' };
  }
  return { ok: true, value };
}

export type ParsedNextActionNote =
  | { ok: true; value: string | null }
  | { ok: false; error: 'too_long' };

/** Trim; blank means "no note". Over the column width is refused, never cut. */
export function parseNextActionNote(input: unknown): ParsedNextActionNote {
  if (input === null || input === undefined) return { ok: true, value: null };
  const text = String(input).trim();
  if (!text) return { ok: true, value: null };
  if (text.length > NEXT_ACTION_NOTE_MAX) return { ok: false, error: 'too_long' };
  return { ok: true, value: text };
}

/** Same UTC day, or both absent. */
export function sameNextActionDay(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return utcDayIndex(a) === utcDayIndex(b);
}

export interface NextActionState {
  nextActionAt: Date | null;
  nextActionNote: string | null;
  nextActionRemindedAt: Date | null;
}

/**
 * The columns to write for an edit. `undefined` in `next` means "not sent,
 * leave it". Moving the date (or clearing it) clears `nextActionRemindedAt` so
 * the new date gets its own reminder; an unchanged date keeps it, so fixing a
 * typo in the note on the due day does not mail the owner a second time.
 */
export function nextActionPatch(
  current: Pick<NextActionState, 'nextActionAt'>,
  next: { nextActionAt?: Date | null; nextActionNote?: string | null }
): Partial<NextActionState> {
  const patch: Partial<NextActionState> = {};
  if (next.nextActionAt !== undefined) {
    patch.nextActionAt = next.nextActionAt;
    if (!sameNextActionDay(current.nextActionAt, next.nextActionAt)) patch.nextActionRemindedAt = null;
  }
  if (next.nextActionNote !== undefined) patch.nextActionNote = next.nextActionNote;
  return patch;
}

/** Is the reminder for this record's current date due on this tick? */
export function isNextActionReminderDue(
  record: Pick<NextActionState, 'nextActionAt' | 'nextActionRemindedAt'>,
  now: Date | number
): boolean {
  if (!record.nextActionAt || record.nextActionRemindedAt) return false;
  return utcDayIndex(record.nextActionAt) <= utcDayIndex(now);
}

/** Has the follow-up day passed? This is the attention queue's `next_action_due`. */
export function isNextActionOverdue(nextActionAt: Date | null | undefined, now: Date | number): boolean {
  if (!nextActionAt) return false;
  return utcDayIndex(nextActionAt) < utcDayIndex(now);
}

/**
 * Who may read (and write) the next-action fields of a relation: the owner and
 * ADMIN — the same pair PUT /api/mentorship/[id] authorises. The note is the
 * owner's working prose about the person on the other side of the record, so
 * the read paths that hand a relation's scalars to that person (the mentee)
 * or to another role drop all three columns.
 */
export function canSeeNextAction(viewer: { id: string; role: string }, relation: { mentorId: string }): boolean {
  return viewer.role === 'ADMIN' || viewer.id === relation.mentorId;
}

/** A copy of `row` without the next-action columns unless the viewer may read them. */
export function stripNextActionFor<T extends { mentorId: string }>(
  viewer: { id: string; role: string },
  row: T
): T | Omit<T, 'nextActionAt' | 'nextActionNote' | 'nextActionRemindedAt'> {
  if (canSeeNextAction(viewer, row)) return row;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { nextActionAt, nextActionNote, nextActionRemindedAt, ...rest } = row as T & Partial<NextActionState>;
  return rest;
}
