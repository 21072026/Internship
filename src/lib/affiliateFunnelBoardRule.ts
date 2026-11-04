// The admin's partner funnel board (docs/affiliate-module.md § The funnel, #3544)
// — the admin-only half ON TOP of the shared funnel (src/lib/affiliateFunnelRule.ts,
// the numbers the partner portal shows too). Nothing here recounts a step: the
// funnel and the threshold come from the shared module; this file adds the
// warning badges, the commission-window warning, the org total, and the sort
// allowlist.
//
// PURE and dependency-free: no database, no clock — `now` is an input.
// Unit-tested in scripts/test/affiliate-funnel-board-rule.test.mjs.

import { addMonthsUtc } from './affiliateCommissionRule';
import { FUNNEL_PERIODS, stepRate, type Funnel, type FunnelPeriod } from './affiliateFunnelRule';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Badge thresholds. Fixed here on purpose: a badge is a prompt to look, not a setting. */
export const MANY_CLICKS = 100;
export const MOSTLY_PASSIVE_MIN_PAYING = 3;
export const WINDOW_ENDING_DAYS = 30;

export const FUNNEL_BADGES = ['CLICKS_NO_SIGNUPS', 'MOSTLY_PASSIVE', 'WINDOW_ENDING'] as const;
export type FunnelBadge = (typeof FUNNEL_BADGES)[number];

export function emptyFunnel(): Funnel {
  return { clicks: 0, uniqueClicks: 0, registrations: 0, freePeriod: 0, neverPaid: 0, paying: 0, active: 0, passive: 0 };
}

/** The two conversion steps, as the portal's funnel card computes them (`stepRate`, whole %). */
export function funnelRates(f: Funnel): { registrationRate: number | null; payingRate: number | null } {
  return { registrationRate: stepRate(f.clicks, f.registrations), payingRate: stepRate(f.registrations, f.paying) };
}

/** The sum of the partners' funnels. */
export function funnelTotal(funnels: Iterable<Funnel>): Funnel {
  const total = emptyFunnel();
  for (const f of funnels) for (const k of Object.keys(total) as (keyof Funnel)[]) total[k] += f[k];
  return total;
}

export function funnelBadges(row: Pick<Funnel, 'clicks' | 'registrations' | 'paying' | 'passive'> & { windowEndingSoon: number }): FunnelBadge[] {
  const badges: FunnelBadge[] = [];
  if (row.clicks > MANY_CLICKS && row.registrations === 0) badges.push('CLICKS_NO_SIGNUPS');
  if (row.paying >= MOSTLY_PASSIVE_MIN_PAYING && row.passive * 2 > row.paying) badges.push('MOSTLY_PASSIVE');
  if (row.windowEndingSoon > 0) badges.push('WINDOW_ENDING');
  return badges;
}

/**
 * How many customers of one partner still earn and see their commission window
 * close within WINDOW_ENDING_DAYS: ACTIVE customers whose window
 * (`windowMonths` from their first valid payment) ends after `now` and no later
 * than `now` + 30 days. Zero while the partner has not reached the percent phase
 * (`switched`), without a window in the plan, or once a STOP_ALL termination has
 * taken effect — no commission is accruing then. A customer first paid at or
 * after the termination has no ordinal, as in the engine, and is skipped.
 */
export function windowEndingSoon(input: {
  now: Date;
  windowMonths: number | null;
  afterNotice: 'STOP_ALL' | 'RUN_OUT';
  noticeEffectiveAt: Date | null;
  switched: boolean;
  customers: { status: string; firstValidPaymentAt: Date | null }[];
}): number {
  const { now, windowMonths, noticeEffectiveAt } = input;
  if (!input.switched || windowMonths === null) return 0;
  const notice = noticeEffectiveAt?.getTime() ?? null;
  if (input.afterNotice === 'STOP_ALL' && notice !== null && notice <= now.getTime()) return 0;
  const soon = now.getTime() + WINDOW_ENDING_DAYS * DAY_MS;
  let n = 0;
  for (const c of input.customers) {
    if (c.status !== 'ACTIVE' || !c.firstValidPaymentAt) continue;
    if (notice !== null && c.firstValidPaymentAt.getTime() >= notice) continue;
    const ends = addMonthsUtc(c.firstValidPaymentAt, windowMonths).getTime();
    if (ends > now.getTime() && ends <= soon) n += 1;
  }
  return n;
}

// ── Sorting (the #3539 allowlist pattern) ───────────────────────────────────
// A request names a sort KEY; this table maps it to a value. No request string
// ever reaches a query, and every order ends with the partner id so equal rows
// keep a stable order across pages.

export const FUNNEL_SORTS = [
  'partner',
  'clicks',
  'uniqueClicks',
  'registrations',
  'paying',
  'active',
  'passive',
  'registrationRate',
  'payingRate',
  'toThreshold',
] as const;
export type FunnelSort = (typeof FUNNEL_SORTS)[number];
export type SortDir = 'asc' | 'desc';

export interface FunnelBoardRow extends Funnel {
  partnerId: string;
  displayName: string;
  registrationRate: number | null;
  payingRate: number | null;
  /** Customers left to the plan's switch; 0 once reached; null without a threshold. */
  toThreshold: number | null;
}

const SORT_VALUE: Record<FunnelSort, (r: FunnelBoardRow) => string | number | null> = {
  partner: (r) => r.displayName.toLocaleLowerCase('en'),
  clicks: (r) => r.clicks,
  uniqueClicks: (r) => r.uniqueClicks,
  registrations: (r) => r.registrations,
  paying: (r) => r.paying,
  active: (r) => r.active,
  passive: (r) => r.passive,
  registrationRate: (r) => r.registrationRate,
  payingRate: (r) => r.payingRate,
  toThreshold: (r) => r.toThreshold,
};

export type FunnelBoardQuery = { period: FunnelPeriod; sort: FunnelSort; dir: SortDir; page: number };
export const FUNNEL_PAGE_SIZE = 50;

/**
 * Reads `period`, `sort`, `dir` and `page` for the admin board. Absent values
 * take their default; a present value outside the allowlist is refused (400),
 * never passed on.
 */
export function parseFunnelBoardQuery(
  params: URLSearchParams,
): { ok: true; query: FunnelBoardQuery } | { ok: false; field: 'period' | 'sort' | 'dir' | 'page' } {
  const period = params.get('period') ?? 'month';
  if (!(FUNNEL_PERIODS as readonly string[]).includes(period)) return { ok: false, field: 'period' };
  const sort = params.get('sort') ?? 'clicks';
  if (!(FUNNEL_SORTS as readonly string[]).includes(sort)) return { ok: false, field: 'sort' };
  const dir = params.get('dir') ?? 'desc';
  if (dir !== 'asc' && dir !== 'desc') return { ok: false, field: 'dir' };
  const rawPage = params.get('page') ?? '1';
  const page = /^\d{1,6}$/.test(rawPage) ? Number(rawPage) : NaN;
  if (!Number.isInteger(page) || page < 1) return { ok: false, field: 'page' };
  return { ok: true, query: { period: period as FunnelPeriod, sort: sort as FunnelSort, dir, page } };
}

/** Sorted copy. A null value (no rate, no threshold) sorts last in both directions; ties by id. */
export function sortFunnelRows<T extends FunnelBoardRow>(rows: T[], sort: FunnelSort, dir: SortDir): T[] {
  const value = SORT_VALUE[sort];
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return (va < vb ? -1 : 1) * sign;
    }
    return a.partnerId < b.partnerId ? -1 : a.partnerId > b.partnerId ? 1 : 0;
  });
}
