// Per-stage service levels (#817). Server-only (reads the DB).
//
// What was already here before this: `MentorshipRelation.stageDeadline`, the
// overdue column in the aging report, `checkStageDeadlineReminders()` (already
// idempotent through `deadlineReminderSentAt`) and the mentor attention queue's
// `overdue` signal. All of it passive, because the deadline had to be typed in
// by hand for each relation. This module is the missing half: an org states the
// rule once, and every stage move applies it.
//
// CALENDAR DAYS by default — see the note on the StageSla model. An org or a
// programme may opt into BUSINESS DAYS with a holiday calendar (#1638,
// `slaDayMode`, docs/business-day-slas.md); with nothing configured every
// deadline is exactly the calendar date it always was.

import { cache } from 'react';
import { prisma } from './prisma';
import { resolveSlaEscalations, slaDaysByStage, type SlaScope, type StageSlaRow } from './stageSlaRule';
import { resolveSetting } from './settingsResolver';
import { appTimeZone, isValidTimeZone } from './timezone';
import { parseWorkingDays, slaDeadline, type SlaDayRule } from './businessDays';

export interface StageSlaEntry {
  stageKey: string;
  days: number;
}

/** Who a service level is being resolved for: an org, optionally narrowed to a relation's cohort and mentor (#1640). */
export interface StageSlaScope extends SlaScope {
  orgId: string | null | undefined;
}

/**
 * Every `StageSla` row of an org that carries a service level, in every scope.
 * Cached per org for the length of the request (React `cache`) — the aging
 * report and a bulk move resolve a scope per row, and each of those must not
 * be a query. Outside a request `cache` is a pass-through, which is correct
 * for a cron tick.
 *
 * Rows with a null `days` are skipped: since #1439 a `StageSla` row can exist
 * for its `wipLimit` alone, and a board-only row must not make this org look
 * "SLA-managed" — that flag is what clears a hand-typed deadline on every stage
 * move (see `stageDeadlineUpdate` below).
 */
export const loadStageSlaRows = cache(async (orgId: string): Promise<StageSlaRow[]> => {
  return prisma.stageSla.findMany({
    where: { orgId, days: { not: null } },
    select: { stageKey: true, days: true, escalateAfterDays: true, cohortId: true, mentorId: true },
  });
});

/**
 * The service level per stage, keyed by stage. Empty when none applies.
 *
 * Given a bare orgId it answers for the ORG'S OWN rows only — what every
 * caller read before overrides existed, and what the admin form shows as the
 * inherited value. Given a scope it applies the precedence in
 * src/lib/stageSlaRule.ts: mentor+cohort → mentor → cohort → org.
 */
export async function resolveStageSlas(scope: string | null | undefined | StageSlaScope): Promise<Map<string, number>> {
  const { orgId, cohortId, mentorId } = typeof scope === 'object' && scope !== null ? scope : { orgId: scope };
  if (!orgId) return new Map();
  return slaDaysByStage(await loadStageSlaRows(orgId), { cohortId, mentorId });
}

/**
 * The escalation ladder's second rung per stage (#1722), keyed by stage: how
 * many days after a breach the org's administrators are told. Only stages that
 * also carry a service level — an escalation of a deadline nobody set means
 * nothing.
 *
 * Scoped like `resolveStageSlas` (#3204): a bare orgId reads the org's own
 * rows, a scope resolves field by field (`resolveSlaEscalations`), so an
 * override without a rung of its own inherits the org's.
 */
export async function resolveStageEscalations(
  scope: string | null | undefined | StageSlaScope
): Promise<Map<string, number>> {
  const { orgId, cohortId, mentorId } = typeof scope === 'object' && scope !== null ? scope : { orgId: scope };
  if (!orgId) return new Map();
  return resolveSlaEscalations(await loadStageSlaRows(orgId), { cohortId, mentorId });
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
    where: { orgId, scope: 'org', wipLimit: { not: null } },
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
 * "Configured" is judged for the relation's own scope (#1640): pass its
 * cohortId and mentorId and an override counts, a bare orgId reads the org's
 * rows only. An org with no override rows therefore behaves exactly as before.
 *
 * Either way the reminder is re-armed, so the next genuine breach alerts even
 * if a previous one already did.
 */
export async function stageDeadlineUpdate(
  scope: string | null | undefined | StageSlaScope,
  stageKey: string,
  now: Date = new Date()
): Promise<{ stageDeadline: Date | null; deadlineReminderSentAt: null } | null> {
  const slas = await resolveStageSlas(scope);
  if (slas.size === 0) return null;
  const days = slas.get(stageKey);
  const rule = days != null ? await resolveSlaDayRule(scope) : null;
  return {
    stageDeadline: days != null ? slaDeadline(now, days, rule) : null,
    deadlineReminderSentAt: null,
  };
}

/**
 * How N days of service level become a date for this scope (#1638): the
 * `slaDayMode` / `slaWorkingDays` / `slaTimeZone` / `slaHolidayCalendarId`
 * settings, resolved programme → org → global (the relation's cohort is its
 * programme). `calendar` — the default — never reads a holiday. A calendar id
 * that is not this org's reads as no calendar: a setting can never pull in
 * another tenant's dates.
 */
export async function resolveSlaDayRule(scope: string | null | undefined | StageSlaScope): Promise<SlaDayRule> {
  const { orgId, cohortId } = typeof scope === 'object' && scope !== null ? scope : { orgId: scope, cohortId: null };
  const settingsScope = { orgId: orgId ?? null, programId: cohortId ?? null };
  const [mode, workingDays, zone, calendarId] = await Promise.all([
    resolveSetting('slaDayMode', settingsScope),
    resolveSetting('slaWorkingDays', settingsScope),
    resolveSetting('slaTimeZone', settingsScope),
    resolveSetting('slaHolidayCalendarId', settingsScope),
  ]);
  const timeZone = isValidTimeZone(zone) ? zone : appTimeZone();
  if (mode !== 'business') return { mode: 'calendar', workingDays: parseWorkingDays(workingDays), holidays: [], timeZone };
  const holidays = calendarId && orgId ? await loadHolidayDates(orgId, calendarId) : [];
  return { mode: 'business', workingDays: parseWorkingDays(workingDays), holidays, timeZone };
}

/** The `YYYY-MM-DD` dates of one of this org's calendars (none for another org's id). */
export const loadHolidayDates = cache(async (orgId: string, calendarId: string): Promise<string[]> => {
  const rows = await prisma.holiday.findMany({
    where: { calendarId, calendar: { orgId } },
    select: { date: true },
  });
  return rows.map((r) => r.date.toISOString().slice(0, 10));
});
