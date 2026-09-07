// THE billing meter (#1750). There is exactly one in this repo.
//
// "How many active pairs does this tenant have?" used to be answerable three
// slightly different ways — a plan-gate count with no activity requirement, a
// global dashboard count with no tenant at all, and whatever a reader of the
// pricing page assumed. A number that goes on an invoice must have exactly one
// definition, or it does not survive its first argument with a customer.
//
// The definition itself — and the reasoning behind every word of it — lives in
// lib/meteringRules.ts, which is dependency-free so it can be unit-tested
// (scripts/test/metering.test.mjs). This file is its database half: the same
// rule, asked of MySQL in one round trip. Everything the rule exports is
// re-exported here, so a caller needs one import and cannot pick up half of
// the definition.
//
// Nothing here gates anything. Metering reports; the plan gate (lib/planGate.ts)
// is the only thing in the product that says no, and video is never gated at
// all — see recordVideoUsage below.

import { Prisma, type MentorshipStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  ACTIVITY_SIGNALS,
  BILLABLE_RELATION_STATES,
  USAGE_METRICS,
  currentPeriod,
  periodRange,
  type Period,
  type UsageMetric,
} from '@/lib/meteringRules';

export * from '@/lib/meteringRules';

/**
 * One `where` fragment per activity signal, keyed by the signal's relation name.
 *
 * A `Record` over the signal names rather than a loop over strings: the key
 * type is derived from ACTIVITY_SIGNALS, so adding a signal there fails the
 * typecheck until its filter is written here, and every filter below is
 * checked against Prisma's own input types instead of being a computed-key
 * object nobody validates until it throws at 03:00.
 */
const ACTIVITY_FILTERS: Record<
  (typeof ACTIVITY_SIGNALS)[number]['relation'],
  (window: { gte: Date; lt: Date }) => Prisma.MentorshipRelationWhereInput
> = {
  // `date`, not `createdAt` — see ACTIVITY_SIGNALS for why.
  interactions: (w) => ({ interactions: { some: { date: w } } }),
  messages: (w) => ({ messages: { some: { createdAt: w } } }),
  meetings: (w) => ({ meetings: { some: { createdAt: w } } }),
  meetingRequests: (w) => ({ meetingRequests: { some: { createdAt: w } } }),
  statusChanges: (w) => ({ statusChanges: { some: { createdAt: w } } }),
  weeklyReports: (w) => ({ weeklyReports: { some: { createdAt: w } } }),
  goals: (w) => ({ goals: { some: { createdAt: w } } }),
};

/**
 * The billable-pair `where`, as one filter. Exported so a caller that needs the
 * rows (not the count) still asks the same question — nobody re-writes it.
 */
export function activeMatchedPairsWhere(orgId: string, period: Period): Prisma.MentorshipRelationWhereInput {
  const window = periodRange(period);
  return {
    orgId,
    // The allowlist, straight from the rule. A state that is not in it — today
    // COMPLETED, tomorrow PAUSED/BENCHED — is excluded without this line
    // changing.
    status: { in: [...BILLABLE_RELATION_STATES] as MentorshipStatus[] },
    // "any logged activity in the calendar month". One OR over `some` filters,
    // so this is a single query and not seven round trips per tenant.
    OR: ACTIVITY_SIGNALS.map((signal) => ACTIVITY_FILTERS[signal.relation](window)),
  };
}

/**
 * The billable unit: "a relation in ACTIVE state with any logged activity in
 * the calendar month; paused, benched and completed pairs are not counted."
 *
 * A relation carrying `dormantSince` needs no special handling — it is quiet,
 * so it has no activity row in the month, so it is not counted. Deliberately
 * no reference to dormancy here (docs/dormant-first-contacts.md owns that
 * concept; this file owns the invoice).
 */
export async function activeMatchedPairs(orgId: string, period: Period = currentPeriod()): Promise<number> {
  return prisma.mentorshipRelation.count({ where: activeMatchedPairsWhere(orgId, period) });
}

/**
 * Active ADMIN seats — the second metered number a customer sees, from the
 * same file as the first so the two can never be computed by different rules.
 * ADMINs only: a mentor seat and a mentee seat are free and are on the
 * deliberately-not-metered list in docs/metering.md.
 */
export async function countAdminSeats(orgId: string): Promise<number> {
  return prisma.user.count({ where: { orgId, role: 'ADMIN', isActive: true } });
}

/**
 * Relations PROVISIONED in a billable state, with no activity requirement.
 *
 * This is NOT the billing number and must never be used as one — it is what
 * the plan gate caps ("you may not run more than 25 active mentorships"), a
 * question about capacity rather than about a month's usage. It lives here so
 * that the two commercial counts sit side by side and a reader can see which
 * is which, instead of the difference being rediscovered every quarter.
 */
export async function countActiveRelations(orgId: string): Promise<number> {
  return prisma.mentorshipRelation.count({
    where: { orgId, status: { in: [...BILLABLE_RELATION_STATES] as MentorshipStatus[] } },
  });
}

// ── The ledger (UsageRollup) ────────────────────────────────────────────────
// One row per (org, metric, period). COMPUTED metrics are written absolutely
// so a re-run is a no-op; COUNTER metrics are incremented as they happen and
// the rollup never touches them. `setUsage` and `recordUsage` refuse each
// other's metrics, which is what keeps a re-run from doubling an invoice.

/**
 * Write a COMPUTED metric for a period, absolutely. Idempotent by
 * construction: the same inputs produce the same row, and exactly one row per
 * (org, metric, period) exists because the column triple is unique.
 */
export async function setUsage(input: {
  orgId: string;
  metric: UsageMetric;
  period: Period;
  value: number;
}): Promise<void> {
  const { orgId, metric, period, value } = input;
  if (USAGE_METRICS[metric].kind !== 'COMPUTED') {
    throw new Error(`setUsage refuses ${metric}: it is a counter — use recordUsage()`);
  }
  await prisma.usageRollup.upsert({
    where: { orgId_metric_period: { orgId, metric, period } },
    create: { orgId, metric, period, value, computedAt: new Date() },
    update: { value, computedAt: new Date() },
  });
}

/**
 * Increment a COUNTER metric as the thing happens. Best-effort and never
 * throws: metering must not be able to fail a user's action. A lost increment
 * makes a report low, which is a report we fix; a 500 on "create a meeting"
 * is a broken product.
 */
export async function recordUsage(input: {
  orgId: string | null | undefined;
  metric: UsageMetric;
  amount?: number;
  at?: Date;
}): Promise<boolean> {
  const { orgId, metric } = input;
  const amount = input.amount ?? 1;
  if (USAGE_METRICS[metric].kind !== 'COUNTER') {
    throw new Error(`recordUsage refuses ${metric}: it is recomputed by the rollup — use setUsage()`);
  }
  // No tenant resolved (a public/unassigned context) → nothing to bill to.
  // Silently skipped: the alternative is a row that belongs to nobody.
  if (!orgId || amount <= 0) return false;

  const period = currentPeriod(input.at);
  try {
    await prisma.usageRollup.upsert({
      where: { orgId_metric_period: { orgId, metric, period } },
      create: { orgId, metric, period, value: amount, computedAt: new Date() },
      update: { value: { increment: amount }, computedAt: new Date() },
    });
    return true;
  } catch (e) {
    logger.warning('Usage counter not recorded', { metric, period, error: String(e) });
    return false;
  }
}

/** Every metric recorded for a tenant in a period, as a metric → value map. */
export async function getUsage(orgId: string, period: Period): Promise<Partial<Record<UsageMetric, number>>> {
  const rows = await prisma.usageRollup.findMany({
    where: { orgId, period },
    select: { metric: true, value: true },
  });
  const out: Partial<Record<UsageMetric, number>> = {};
  for (const row of rows) out[row.metric as UsageMetric] = row.value;
  return out;
}

// ── Video volume ────────────────────────────────────────────────────────────

/**
 * Count a video room and the heads it was created for.
 *
 * REPORTED, NEVER GATED. JaaS MAU is a metered allowance and every participant
 * of a JaaS room counts against it (lib/meetingRoom.ts explains the routing),
 * so today "are we close to the ceiling?" is a guess. This turns it into a
 * number. It does not — and must never — decide whether a call happens:
 * meetings and video are part of the free core, and no path here returns a 403.
 *
 * Fire-and-forget on purpose: the caller is `generateMeetingLink()`, a
 * synchronous function on the room-creation chokepoint, and a meter must not
 * add a failure mode (or a round trip) to creating a room.
 */
export function recordVideoUsage(opts: { orgId: string | null | undefined; inviteeCount: number | null }): void {
  if (!opts.orgId) return;
  void recordUsage({ orgId: opts.orgId, metric: 'VIDEO_ROOM', amount: 1 });
  // `null` invitees means "audience derived later" (a recurring series), so the
  // head-count is genuinely unknown rather than zero — the room is still
  // counted above, and nothing is invented here.
  if (opts.inviteeCount && opts.inviteeCount > 0) {
    void recordUsage({ orgId: opts.orgId, metric: 'VIDEO_PARTICIPANT', amount: opts.inviteeCount });
  }
}

/**
 * Count one activity signal against a tenant's pairs (#1750, item 4).
 *
 * Volume, NOT the pair count: one pair can raise this fifty times in a month
 * and is still one billable pair. It exists so the rollup can eventually read
 * a stream instead of scanning seven domain tables — until then
 * `activeMatchedPairs()` is the truth and this is the signal we are collecting
 * to replace it. Best-effort and never awaited by a write path.
 */
export function recordPairActivity(orgId: string | null | undefined, amount = 1): void {
  if (!orgId) return;
  void recordUsage({ orgId, metric: 'ACTIVE_PAIR_ACTIVITY', amount });
}
