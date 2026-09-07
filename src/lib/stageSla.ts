// Per-stage service levels (#817). Server-only (reads the DB).
//
// What was already here before this: `MentorshipRelation.stageDeadline`, the
// overdue column in the aging report, `checkStageDeadlineReminders()` (already
// idempotent through `deadlineReminderSentAt`) and the mentor attention queue's
// `overdue` signal. All of it passive, because the deadline had to be typed in
// by hand for each relation. This module is the missing half: an org states the
// rule once, and every stage move applies it.
//
// CALENDAR DAYS, not business days — see the note on the StageSla model. The
// decision is recorded in the schema, in the admin hint and in the PR rather
// than left implicit.

import { prisma } from './prisma';

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
    stageDeadline: days != null ? new Date(now.getTime() + days * DAY) : null,
    deadlineReminderSentAt: null,
  };
}
