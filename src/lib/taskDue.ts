// When a to-do is late (#2440).
//
// The repo already had a rich overdue vocabulary and every bit of it was about
// the *stage* clock (`stageClock.ts`, `StageSla.days`, `StageClockChip`); the
// to-do itself carried no date at all. `ProjectTask.dueDate` is that date, and
// this module is the single place that decides what "late" means for it — the
// row, the counter tile, the team list and anything that mails about it all
// read the answer from here instead of comparing timestamps of their own.
//
// Two rules, both load-bearing:
//
//  1. Late is a CALENDAR DAY comparison, never an instant. A to-do due today at
//     09:00 is NOT late at 17:00 — it is due today. Only a day strictly BEFORE
//     today is late. Comparing `dueDate < new Date()` is the bug this exists to
//     prevent: it turns every same-day to-do red halfway through the morning.
//
//  2. The stored value names a DAY, not a moment. An `<input type="date">`
//     sends `YYYY-MM-DD`, which `new Date(...)` reads as UTC midnight — the way
//     /api/goals already stores `Goal.dueDate` — so the day it names is read off
//     its UTC parts. "Today", by contrast, is the reader's own local day,
//     because that is what a person means by the word. Reading the due day in
//     local time instead would move it by one for everyone west of UTC.
//
// Client-safe on purpose: no Prisma. The row classifies the date in the browser
// and the server counts overdue rows with the same function, so the two cannot
// drift.

// One definition of a day for the whole overdue vocabulary — the stage clock's.
import { DAY_MS } from './stageClock';

export type TaskDueTone = 'overdue' | 'today' | 'upcoming';

export interface TaskDueState {
  tone: TaskDueTone;
  /**
   * Whole calendar days between today and the due day: -1 = yesterday,
   * 0 = today, 2 = the day after tomorrow.
   */
  days: number;
  overdue: boolean;
}

const dayNumber = (ms: number): number => Math.floor(ms / DAY_MS);

/** The day the stored value names, read off its UTC parts (rule 2). */
const dueDayNumber = (due: Date): number =>
  dayNumber(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()));

/** The reader's own day, on their own clock (rule 2). */
const todayNumber = (now: Date): number =>
  dayNumber(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

/**
 * How a due date stands relative to today, or `null` when there is no date —
 * which is the normal case and never an error: most to-dos carry no deadline.
 */
export function taskDueState(
  dueDate: Date | string | null | undefined,
  now: Date | number = new Date()
): TaskDueState | null {
  if (dueDate === null || dueDate === undefined || dueDate === '') return null;
  const due = typeof dueDate === 'string' ? new Date(dueDate) : dueDate;
  if (Number.isNaN(due.getTime())) return null;
  const nowDate = typeof now === 'number' ? new Date(now) : now;
  const days = dueDayNumber(due) - todayNumber(nowDate);
  return { days, overdue: days < 0, tone: days < 0 ? 'overdue' : days === 0 ? 'today' : 'upcoming' };
}

/** A finished to-do is never late, whatever its date says. */
export function isTaskOverdue(
  task: { dueDate?: Date | string | null; done?: boolean } | null | undefined,
  now?: Date | number
): boolean {
  if (!task || task.done) return false;
  return taskDueState(task.dueDate, now)?.overdue === true;
}

/** How many of these are late — the number behind the counter tile. */
export function countOverdueTasks(
  tasks: ReadonlyArray<{ dueDate?: Date | string | null; done?: boolean }>,
  now?: Date | number
): number {
  let n = 0;
  for (const task of tasks) if (isTaskOverdue(task, now)) n += 1;
  return n;
}

/**
 * The bound a database query compares against to mean "late": a row whose
 * `dueDate` is strictly BEFORE this instant is overdue, one that falls on or
 * after it is not. Today's own to-dos sit on the boundary and are therefore
 * never selected — rule 1, expressed as SQL.
 */
export function overdueBefore(now: Date | number = new Date()): Date {
  const nowDate = typeof now === 'number' ? new Date(now) : now;
  return new Date(todayNumber(nowDate) * DAY_MS);
}
