// What a tenant admin reads on the usage tab of /admin/billing (#1763): every
// metered number, its plan limit and four periods of trend.
//
// PURE, like billingSummary.ts next door: the route (GET /api/org/usage) reads
// the Subscription and the UsageRollup rows and hands them here, so the
// ok / approaching / over arithmetic is unit-tested
// (e2e/org-usage.unit.spec.ts). Every number is a rollup row the nightly job
// wrote (src/lib/jobs/usageRollup.ts) — a request never scans a domain table —
// and a period without a row reads `null` ("not computed yet"), never 0.
//
// The active-pair row is the SAME rollup row the plan tab reads
// (ACTIVE_MATCHED_PAIRS, written by activeMatchedPairs()), against the same
// band (planLimits() of the same resolved plan), so the two tabs cannot show
// two different numbers.

import { FREE_PLAN_KEY, getPlan, planLimits, type PlanLimits } from '@/lib/plans';
import type { Period, UsageMetric } from '@/lib/meteringRules';
import { trailingPeriods } from '@/lib/billingSummary';

export const USAGE_HISTORY_PERIODS = 4;

/** At or above this share of the limit a row reads "approaching". */
export const APPROACHING_SHARE = 0.8;

export type UsageRowKey =
  | 'activePairs'
  | 'adminSeats'
  | 'companies'
  | 'programs'
  | 'aiCalls'
  | 'broadcastRecipients'
  | 'videoRooms'
  | 'videoParticipants';

/**
 * Row → its ledger metric and the plan limit it is measured against. `null`
 * limit key = reported, never limited: video volume is metered for our own
 * cost picture and no meeting path may refuse for it (docs/metering.md).
 */
export const USAGE_ROWS: readonly { key: UsageRowKey; metric: UsageMetric; limit: keyof PlanLimits | null }[] = [
  { key: 'activePairs', metric: 'ACTIVE_MATCHED_PAIRS', limit: 'activePairs' },
  { key: 'adminSeats', metric: 'ADMIN_SEATS', limit: 'adminSeats' },
  { key: 'companies', metric: 'COMPANIES', limit: 'companies' },
  { key: 'programs', metric: 'PROGRAMS', limit: 'programs' },
  { key: 'aiCalls', metric: 'AI_CALLS', limit: 'aiCallsPerMonth' },
  { key: 'broadcastRecipients', metric: 'BROADCAST_RECIPIENTS', limit: 'monthlyBroadcastRecipients' },
  { key: 'videoRooms', metric: 'VIDEO_ROOM', limit: null },
  { key: 'videoParticipants', metric: 'VIDEO_PARTICIPANT', limit: null },
];

export const USAGE_METRIC_NAMES: readonly UsageMetric[] = USAGE_ROWS.map((r) => r.metric);

/**
 * - `unlimited`: the plan sets no limit (null) — never rendered as 0 or as over.
 * - `not_included`: the limit is 0, the meter does not apply to this plan.
 * - `reported`: volume we report and never limit (video).
 * - `pending`: no rollup row for the current period yet.
 */
export type UsageState = 'ok' | 'approaching' | 'over' | 'unlimited' | 'not_included' | 'reported' | 'pending';

export function usageState(value: number | null, limit: number | null, limited: boolean): UsageState {
  if (!limited) return 'reported';
  if (limit === null) return 'unlimited';
  if (limit === 0) return 'not_included';
  if (value === null) return 'pending';
  if (value > limit) return 'over';
  if (value >= limit * APPROACHING_SHARE) return 'approaching';
  return 'ok';
}

export interface UsageRow {
  key: UsageRowKey;
  /** The current period's value; null until the nightly rollup wrote it. */
  value: number | null;
  limit: number | null;
  state: UsageState;
  /** Oldest first, exactly USAGE_HISTORY_PERIODS entries, the current one last. */
  history: { period: Period; value: number | null }[];
}

export interface UsageSummary {
  period: Period;
  plan: { key: string; name: string };
  computedAt: string | null;
  rows: UsageRow[];
  /** True when any limited row is over its limit — the screen then offers the plan change. */
  anyOver: boolean;
}

export interface UsageRollupInput {
  metric: string;
  period: string;
  value: number;
  computedAt: string;
}

export function buildUsageSummary(input: {
  planKey: string;
  period: Period;
  rollups: readonly UsageRollupInput[];
  /** An operator cap that tightens the broadcast band (broadcastQuota.ts); never raises it. */
  broadcastLimit?: number | null;
}): UsageSummary {
  // An unknown key resolves to the programme-side free tier — the same fallback
  // the plan tab (buildBillingSummary) uses, so the bands agree.
  const plan = getPlan(input.planKey) ?? getPlan(FREE_PLAN_KEY.PROGRAM)!;
  const limits = planLimits(plan.key);
  const periods = trailingPeriods(input.period, USAGE_HISTORY_PERIODS).reverse();

  const byKey = new Map<string, UsageRollupInput>();
  for (const r of input.rollups) byKey.set(`${r.metric}|${r.period}`, r);

  let computedAt: string | null = null;
  const rows = USAGE_ROWS.map(({ key, metric, limit: limitKey }) => {
    const history = periods.map((p) => ({ period: p, value: byKey.get(`${metric}|${p}`)?.value ?? null }));
    const cur = byKey.get(`${metric}|${input.period}`);
    if (cur && (!computedAt || cur.computedAt > computedAt)) computedAt = cur.computedAt;
    let limit = limitKey ? limits[limitKey] : null;
    if (key === 'broadcastRecipients' && input.broadcastLimit !== undefined) limit = input.broadcastLimit;
    const value = cur?.value ?? null;
    return { key, value, limit, state: usageState(value, limit, limitKey !== null), history };
  });

  return {
    period: input.period,
    plan: { key: plan.key, name: plan.name },
    computedAt,
    rows,
    anyOver: rows.some((r) => r.state === 'over'),
  };
}
