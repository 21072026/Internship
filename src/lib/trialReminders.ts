// The queries behind the trial reminder ladder (#2413, story #2392).
//
// The RULE — which (record, threshold) pairs are due on a given tick — lives in
// lib/trialReminderRule.ts and is dependency-free so it can be unit-tested
// without a database (scripts/test/trial-reminder-rule.test.mjs). This module is
// the Prisma-aware half: it finds the candidates, reads back what has already
// been claimed, and hands both to the rule. Everything from the rule module is
// re-exported here, so a caller only ever imports one of the two — the same
// split as lib/lastContact.ts over lib/lastContactRule.ts.
//
// THE JOB IS NOT HERE. Sending the mail, the bell notification, the per-tenant
// `verticalFor(orgId)` gate and the `{ considered, sent, skipped, failed }`
// counts are #2415 (src/lib/jobs/trialReminders.ts). This module deliberately
// writes nothing — not even the claim row — so the selection can be exercised
// on its own.

import { prisma } from './prisma';
import { resolvePipelineStages } from './pipelineStages';
import { TRIAL_ACTIVE_STAGE_KEY } from './programTemplates';
import {
  TRIAL_REMINDER_THRESHOLDS,
  selectDueTrialReminders,
  type DueTrialReminder,
} from './trialReminderRule';

export * from './trialReminderRule';

/** The funnel record a due reminder is about, with what a sender needs to write it. */
export interface DueTrialRelation {
  id: string;
  orgId: string | null;
  /** The account owner — `mentorId` is what the MARKETING overlay calls the owner. */
  mentorId: string;
  menteeId: string;
  companyId: string | null;
  companyName: string | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date;
}

export interface DueTrialReminderRow extends DueTrialReminder {
  relation: DueTrialRelation;
}

export interface FindDueTrialRemindersOptions {
  /** Injected clock, so the caller's whole tick runs off one moment. */
  now?: Date;
  /** Override the ladder; defaults to TRIAL_REMINDER_THRESHOLDS. */
  thresholds?: readonly number[];
}

/**
 * The key of this tenant's "trial running" stage, or null when it has none.
 *
 * Resolved through the tenant's own `PipelineStage` rows rather than compared
 * against a literal at the query site: an INTERNSHIP org, or a MARKETING org
 * that deleted the stage, has no trial stage at all and must be skipped
 * entirely rather than swept with a key that matches nothing. The key itself is
 * named once, in lib/programTemplates.ts next to the preset that ships it — the
 * LABEL is the tenant's to rename, the key is not (#1886 is the guard for the
 * canonical keys; this is the same discipline for the marketing preset's).
 */
export async function trialActiveStageKey(orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null;
  const stages = await resolvePipelineStages(orgId);
  return stages.find((s) => s.key === TRIAL_ACTIVE_STAGE_KEY)?.key ?? null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every trial reminder that is due for one tenant on this tick.
 *
 * One tenant per call on purpose: the trial stage is resolved per org, so a
 * platform-wide sweep is a loop over orgs in the job (#2415) — which is also
 * where `verticalFor(orgId)` decides whether a tenant is in this product at
 * all.
 *
 * The SQL window is a coarse prefilter, not the decision. It spans one day
 * either side of the ladder so nothing near a boundary can be excluded by it,
 * and the exact calendar-day match is made by the pure rule — one definition of
 * "due", in the module that is tested.
 *
 * Scoping: `orgId` is passed explicitly rather than relied on from the tenant
 * middleware, because the caller is a cron with no session and therefore no
 * bound context (the same reason lib/rosterIngestStore.ts binds its own). It is
 * also correct when the caller DOES bind one — the middleware would merge the
 * identical value.
 */
export async function findDueTrialReminders(
  orgId: string,
  { now = new Date(), thresholds = TRIAL_REMINDER_THRESHOLDS }: FindDueTrialRemindersOptions = {},
): Promise<DueTrialReminderRow[]> {
  const stageKey = await trialActiveStageKey(orgId);
  if (!stageKey) return [];

  const ladder = [...thresholds].filter((t) => Number.isInteger(t));
  if (ladder.length === 0) return [];
  const windowStart = new Date(now.getTime() - (Math.min(...ladder) + 2) * MS_PER_DAY);
  const windowEnd = new Date(now.getTime() + (Math.max(...ladder) + 2) * MS_PER_DAY);

  const relations = await prisma.mentorshipRelation.findMany({
    where: {
      orgId,
      // A closed record is not waiting for anything — whatever its trial dates
      // still say, nobody should be mailed about it.
      status: 'ACTIVE',
      pipelineStatus: stageKey,
      trialEndsAt: { gte: windowStart, lte: windowEnd },
    },
    select: {
      id: true,
      orgId: true,
      mentorId: true,
      menteeId: true,
      companyId: true,
      trialStartedAt: true,
      trialEndsAt: true,
      company: { select: { name: true } },
    },
  });
  if (relations.length === 0) return [];

  // What has already been claimed, for exactly these records. Read in one query
  // rather than per record: a tenant's trial list is a page, not a row.
  const claims = await prisma.trialReminder.findMany({
    where: { relationId: { in: relations.map((r) => r.id) } },
    select: { relationId: true, threshold: true },
  });
  const claimed = new Map<string, number[]>();
  for (const c of claims) {
    const list = claimed.get(c.relationId);
    if (list) list.push(c.threshold);
    else claimed.set(c.relationId, [c.threshold]);
  }

  const due = selectDueTrialReminders(
    relations.map((r) => ({
      id: r.id,
      trialEndsAt: r.trialEndsAt,
      sentThresholds: claimed.get(r.id) ?? [],
    })),
    { now, thresholds: ladder },
  );

  const byId = new Map(relations.map((r) => [r.id, r]));
  return due.flatMap((d) => {
    const r = byId.get(d.relationId);
    // `trialEndsAt` cannot be null here (the rule skipped those and the query
    // bounded it), but the column is nullable, so narrow rather than assert.
    if (!r?.trialEndsAt) return [];
    return [
      {
        ...d,
        relation: {
          id: r.id,
          orgId: r.orgId,
          mentorId: r.mentorId,
          menteeId: r.menteeId,
          companyId: r.companyId,
          companyName: r.company?.name ?? null,
          trialStartedAt: r.trialStartedAt,
          trialEndsAt: r.trialEndsAt,
        },
      },
    ];
  });
}
