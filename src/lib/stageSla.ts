// Per-stage service levels (#817). Server-only (reads the DB).
//
// What was already here before this: `MentorshipRelation.stageDeadline`, the
// overdue column in the aging report, `checkStageDeadlineReminders()` (already
// idempotent through `deadlineReminderSentAt`) and the mentor attention queue's
// `overdue` signal. All of it passive, because the deadline had to be typed in
// by hand for each relation. This module is the missing half: an org states the
// rule once, and every stage move applies it.
//
// CALENDAR DAYS by default; BUSINESS DAYS when the org opts in (#1638) with
// the `slaDayMode` setting — working days, a holiday calendar and a time zone,
// all per org. The default stays calendar days so no existing deadline moves;
// the arithmetic for the business mode is pure in src/lib/businessDays.ts.

import { prisma } from './prisma';
import { getSetting } from './settings';
import { resolveTimeZone } from './timezone';
import { addBusinessDays, parseWorkingDays, type BusinessDayOptions } from './businessDays';

const DAY = 24 * 60 * 60 * 1000;

export interface StageSlaEntry {
  stageKey: string;
  days: number;
}

/**
 * Every SLA an org has configured, keyed by stage. Empty when it configured none.
 *
 * Rows with a null `days` are skipped: since #1439 a `StageSla` row can exist
 * for its `wipLimit` alone, and a board-only row must not make this org look
 * "SLA-managed" — that flag is what clears a hand-typed deadline on every stage
 * move (see `stageDeadlineUpdate` below).
 */
export async function resolveStageSlas(orgId: string | null | undefined): Promise<Map<string, number>> {
  if (!orgId) return new Map();
  const rows = await prisma.stageSla.findMany({
    where: { orgId, days: { not: null } },
    select: { stageKey: true, days: true },
  });
  return new Map(rows.flatMap((r) => (r.days == null ? [] : [[r.stageKey, r.days] as [string, number]])));
}

/**
 * The escalation ladder's second rung per stage (#1722), keyed by stage: how
 * many days after a breach the org's administrators are told. Only stages that
 * also carry a service level — an escalation of a deadline nobody set means
 * nothing.
 */
export async function resolveStageEscalations(
  orgId: string | null | undefined
): Promise<Map<string, number>> {
  if (!orgId) return new Map();
  const rows = await prisma.stageSla.findMany({
    where: { orgId, days: { not: null }, escalateAfterDays: { not: null } },
    select: { stageKey: true, escalateAfterDays: true },
  });
  return new Map(
    rows.flatMap((r) => (r.escalateAfterDays == null ? [] : [[r.stageKey, r.escalateAfterDays] as [string, number]]))
  );
}

/**
 * Every per-stage board WIP limit an org has configured (#1439), keyed by stage.
 * A stored 0 is kept as 0 — it means "never warn about this stage", which is not
 * the same as having configured nothing. Resolution against the org-wide
 * setting happens in src/lib/boardWip.ts, which is the only place that rule is
 * written.
 */
export async function resolveStageWipLimits(
  orgId: string | null | undefined
): Promise<Map<string, number>> {
  if (!orgId) return new Map();
  const rows = await prisma.stageSla.findMany({
    where: { orgId, wipLimit: { not: null } },
    select: { stageKey: true, wipLimit: true },
  });
  return new Map(rows.flatMap((r) => (r.wipLimit == null ? [] : [[r.stageKey, r.wipLimit] as [string, number]])));
}

/**
 * The deadline a relation should carry after landing on `stageKey`, expressed
 * as the update to apply — or null when this org's `stageDeadline` is not
 * SLA-managed at all.
 *
 * Two rules, both about not surprising an existing installation:
 *
 *   · An org with NO SLA configured is left completely alone. Its deadlines
 *     stay whatever a human typed, exactly as before this feature existed.
 *   · An org that HAS configured SLAs has an SLA-managed field, so moving to a
 *     stage with no SLA CLEARS the deadline: the previous stage's clock stopped
 *     when the candidate left it, and leaving the old date behind would report
 *     an overdue that no longer means anything.
 *
 * Either way the reminder is re-armed, so the next genuine breach alerts even
 * if a previous one already did.
 */
export async function stageDeadlineUpdate(
  orgId: string | null | undefined,
  stageKey: string,
  now: Date = new Date()
): Promise<{ stageDeadline: Date | null; deadlineReminderSentAt: null } | null> {
  const slas = await resolveStageSlas(orgId);
  if (slas.size === 0) return null;
  const days = slas.get(stageKey);
  return {
    stageDeadline: days != null ? slaDeadline(now, days, await resolveSlaDayRule(orgId)) : null,
    deadlineReminderSentAt: null,
  };
}

/** How an org counts its SLA days (#1638): calendar days, or business days with these options. */
export type SlaDayRule = { mode: 'calendar' } | ({ mode: 'business' } & BusinessDayOptions);

/**
 * The org's day rule, from its settings. Calendar unless it opted in. The
 * holiday calendar is read only when it belongs to the same org — a stored id
 * of another tenant's calendar contributes nothing.
 */
export async function resolveSlaDayRule(orgId: string | null | undefined): Promise<SlaDayRule> {
  if (!orgId) return { mode: 'calendar' };
  if ((await getSetting('slaDayMode', orgId)) !== 'business') return { mode: 'calendar' };
  const [workingDays, calendarId, zone] = await Promise.all([
    getSetting('slaWorkingDays', orgId),
    getSetting('slaHolidayCalendarId', orgId),
    getSetting('slaTimeZone', orgId),
  ]);
  const holidays = calendarId
    ? await prisma.holiday.findMany({
        where: { calendar: { id: calendarId, orgId } },
        select: { date: true },
      })
    : [];
  return {
    mode: 'business',
    workingDays: parseWorkingDays(workingDays),
    holidays: new Set(holidays.map((h) => h.date.toISOString().slice(0, 10))),
    timeZone: resolveTimeZone(zone),
  };
}

/** `days` SLA days after `from` under the org's rule. Calendar mode is exactly what it always was. */
export function slaDeadline(from: Date, days: number, rule: SlaDayRule): Date {
  if (rule.mode === 'calendar') return new Date(from.getTime() + days * DAY);
  return addBusinessDays(from, days, rule);
}
