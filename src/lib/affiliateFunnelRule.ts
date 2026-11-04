// A partner's funnel and its threshold progress (docs/affiliate-module.md,
// "The funnel", #3543/#3544) — the pure half. The queries are in
// src/lib/affiliateFunnel.ts, which the partner portal and the admin screens
// both read, so the two can never show different numbers.
//
// PURE and dependency-free: no database, no clock — `now` is an input.
//
//   clicks        — tracked-link clicks in the period (AffiliateClickDaily, #3541)
//   registrations — customers registered in the period, whatever their status
//   paying        — of those, the ones that paid at least once (ACTIVE + PASSIVE)
//   active/passive— the paying ones split by their status today (#3542)
//
// The funnel is a COHORT: every step after the clicks counts the customers who
// registered in the period, judged by today's status. A customer who registered
// last year and paid this month is not in this month's funnel.
import { addMonthsUtc, type CommissionPlan } from './affiliateCommissionRule';
import type { CustomerStatus } from './affiliateCustomerStatusRule';

export const FUNNEL_PERIODS = ['month', 'year', 'all'] as const;
export type FunnelPeriod = (typeof FUNNEL_PERIODS)[number];
export const DEFAULT_FUNNEL_PERIOD: FunnelPeriod = 'month';

export function parseFunnelPeriod(raw: unknown): FunnelPeriod {
  return (FUNNEL_PERIODS as readonly unknown[]).includes(raw) ? (raw as FunnelPeriod) : DEFAULT_FUNNEL_PERIOD;
}

/**
 * The first instant of a period, null for `all`. `month` is the current UTC
 * calendar month; `year` is the current UTC month and the eleven before it —
 * calendar months, so it lines up with the daily click counter's UTC days.
 */
export function periodStart(period: FunnelPeriod, now: Date): Date | null {
  if (period === 'all') return null;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return period === 'month' ? monthStart : addMonthsUtc(monthStart, -11);
}

export interface Funnel {
  clicks: number;
  /** First clicks of a visitor per partner and UTC day (#3541); shown beside `clicks`. */
  uniqueClicks: number;
  registrations: number;
  /** Registrations still in their free period. */
  freePeriod: number;
  /** Registrations that left (or ran out of the free period) without paying. */
  neverPaid: number;
  paying: number;
  active: number;
  passive: number;
}

export function funnelFromCounts(clicks: { clicks: number; uniqueClicks: number }, counts: Record<CustomerStatus, number>): Funnel {
  const paying = counts.ACTIVE + counts.PASSIVE;
  return {
    clicks: clicks.clicks,
    uniqueClicks: clicks.uniqueClicks,
    registrations: counts.FREE_PERIOD + counts.NEVER_PAID + paying,
    freePeriod: counts.FREE_PERIOD,
    neverPaid: counts.NEVER_PAID,
    paying,
    active: counts.ACTIVE,
    passive: counts.PASSIVE,
  };
}

/**
 * A step's share of the step before it, as a whole percent; null when the step
 * before is zero. It can exceed 100 between clicks and registrations: a customer
 * who came through the direct (untracked) link registers without a click.
 */
export function stepRate(previous: number, current: number): number | null {
  if (previous <= 0) return null;
  return Math.round((current / previous) * 100);
}

export interface ThresholdProgress {
  /** The plan's `switchAtCustomer`. */
  target: number;
  /** The partner's paying customers, counted as the engine counts them. */
  paying: number;
  /** How many more paying customers until the percent phase; 0 once reached. */
  left: number;
  /** The percent rate in basis points. */
  bps: number;
  /** When the percent phase started; null until it has. */
  reachedAt: Date | null;
}

/**
 * The "N / target paying customers" indicator. Null when the plan has no
 * switch to a percent (no threshold, or a 0 % rate) — then there is nothing to
 * count towards and the indicator is not shown. `paying` and `switchedAt` come
 * from `evaluatePartner()`, so the ordinal is the engine's: by first-payment
 * date, eligible customers only.
 */
export function thresholdProgress(
  plan: Pick<CommissionPlan, 'switchAtCustomer' | 'percentBps'> | null,
  paying: number,
  switchedAt: Date | null,
): ThresholdProgress | null {
  if (!plan || plan.switchAtCustomer === null || plan.percentBps <= 0) return null;
  const target = plan.switchAtCustomer;
  return {
    target,
    paying,
    left: switchedAt ? 0 : Math.max(0, target - paying),
    bps: plan.percentBps,
    reachedAt: switchedAt,
  };
}
