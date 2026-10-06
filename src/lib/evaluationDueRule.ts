// The INTERIM/FINAL due-date rule (#1891) — pure, client-safe, unit-tested
// (scripts/test/evaluation-due.test.mjs). The sweep that applies it is
// src/lib/evaluationDue.ts; docs/evaluation-due.md is the human copy.

export type DueEvaluationType = 'INTERIM' | 'FINAL';
export const DUE_EVALUATION_TYPES: readonly DueEvaluationType[] = ['INTERIM', 'FINAL'];

/**
 * The built-in schedule, used ONLY when the org has not configured one AND its
 * pipeline still has the key. A renamed or custom pipeline without these keys
 * gets no default — it configures its own stage, or gets nothing, never a guess.
 */
export const DEFAULT_EVALUATION_SCHEDULE: Record<DueEvaluationType, { stageKey: string; afterDays: number }> = {
  // A month into the internship is when there is enough to evaluate and still
  // time to act on what the evaluation says.
  INTERIM: { stageKey: 'INTERNSHIP_IN_PROGRESS_450', afterDays: 30 },
  // The final one is due the day the internship is marked complete.
  FINAL: { stageKey: 'INTERNSHIP_COMPLETED_490', afterDays: 0 },
};

/** Two, never three — the same ceiling as every reminder in this epic. */
export const EVALUATION_MAX_REMINDERS = 2;
/** The second reminder comes a week after the due date, and never sooner than a week after the first. */
export const SECOND_REMINDER_AFTER_DAYS = 7;
/** No backfill: a due date further in the past than this when first seen is not created. */
export const EVALUATION_LOOKBACK_DAYS = 14;

export interface ScheduleEntry {
  stageKey: string;
  afterDays: number;
}

/**
 * The org's schedule per type, or null when that type is off or has no stage
 * this pipeline knows. `configured` is the setting as stored: '' = the built-in
 * default (if the pipeline has its key), 'off' = disabled, anything else = a key.
 */
export function resolveEvaluationSchedule(
  configured: { interimStage: string; interimDays: string; finalStage: string },
  stageKeys: ReadonlySet<string>,
): Record<DueEvaluationType, ScheduleEntry | null> {
  const pick = (type: DueEvaluationType, raw: string, afterDays: number): ScheduleEntry | null => {
    const value = raw.trim();
    if (value === 'off') return null;
    const stageKey = value || DEFAULT_EVALUATION_SCHEDULE[type].stageKey;
    return stageKeys.has(stageKey) ? { stageKey, afterDays } : null;
  };
  const days = parseInt(configured.interimDays, 10);
  return {
    INTERIM: pick('INTERIM', configured.interimStage, Number.isFinite(days) && days >= 0 ? Math.min(days, 365) : DEFAULT_EVALUATION_SCHEDULE.INTERIM.afterDays),
    FINAL: pick('FINAL', configured.finalStage, DEFAULT_EVALUATION_SCHEDULE.FINAL.afterDays),
  };
}

const DAY = 24 * 60 * 60 * 1000;

/** Whether a due date seen for the first time is recent enough to create (no backfill). */
export function dueDateIsCreatable(dueAt: Date, now: Date): boolean {
  return dueAt.getTime() >= now.getTime() - EVALUATION_LOOKBACK_DAYS * DAY;
}

/**
 * Whether reminder `remindersSent + 1` is due now: the first on the due date,
 * the second a week after it and a week after the first — never a third.
 */
export function evaluationReminderDue(
  row: { dueAt: Date; remindersSent: number; lastRemindedAt: Date | null; completedAt: Date | null },
  now: Date,
): boolean {
  if (row.completedAt || row.remindersSent >= EVALUATION_MAX_REMINDERS) return false;
  const t = now.getTime();
  if (row.remindersSent === 0) return t >= row.dueAt.getTime();
  return (
    t >= row.dueAt.getTime() + SECOND_REMINDER_AFTER_DAYS * DAY &&
    (!row.lastRemindedAt || t >= row.lastRemindedAt.getTime() + SECOND_REMINDER_AFTER_DAYS * DAY)
  );
}
