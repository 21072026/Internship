// The partner's notice that a customer's commission window is ending
// (docs/affiliate-module.md, "Window notice", #3556).
//
// PURE and dependency-free, like the engine it reads. Which customers a partner
// hears about, and when, is decided here and nowhere else; the daily job
// (src/lib/jobs/affiliateWindowNotices.ts) only loads the rows and sends.
//
// The rules:
// - The date is the ENGINE's: a customer's window end comes out of
//   `evaluatePartner()`, which reads `customerWindowEndsAt()`. The mail, the
//   portal and the commissions can therefore never name two different days.
// - A notice is due once, when the end is in the future and no further away
//   than the programme's lead time (`windowNoticeDays`, 0 = off). A window that
//   has already ended is never announced after the fact — "ends on 3 March"
//   sent on 5 March is a mail that lies about the one fact it carries. So the
//   first run on a populated database tells only the customers whose end is
//   still ahead, and is no backlog.
// - Only a window that still decides money is announced: the plan has a percent
//   phase, the partner has reached it, the customer counts for the partner
//   (it has an ordinal — first paid before a termination took effect), and,
//   under STOP_ALL, the termination does not end the earning before the window
//   does. A partner whose termination runs out (RUN_OUT) keeps hearing about
//   its customers, because they keep earning.

import type { CommissionPlan, PartnerEvaluation, PartnerFacts } from './affiliateCommissionRule';

/** The lead time a programme starts with, in days. */
export const WINDOW_NOTICE_DAYS_DEFAULT = 30;
/** The longest lead time an admin may set. 0 turns the notice off. */
export const WINDOW_NOTICE_DAYS_MAX = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lead time as a whole number of days in 0…180; anything else is refused (null). */
export function parseWindowNoticeDays(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) return null;
  return n >= 0 && n <= WINDOW_NOTICE_DAYS_MAX ? n : null;
}

/** A stored lead time read back: out of range or missing → the default. */
export function readWindowNoticeDays(stored: unknown): number {
  return parseWindowNoticeDays(stored) ?? WINDOW_NOTICE_DAYS_DEFAULT;
}

/**
 * Whether one window end is due for its notice now: not sent yet, the notice is
 * on, and the end lies in (now, now + leadDays].
 */
export function windowNoticeDue(input: { endsAt: Date | null; now: Date; leadDays: number; sentAt: Date | null }): boolean {
  if (input.endsAt === null || input.sentAt !== null || input.leadDays <= 0) return false;
  const left = input.endsAt.getTime() - input.now.getTime();
  return left > 0 && left <= input.leadDays * DAY_MS;
}

/** Whether the programme's plan has anything a window could end: a percent phase with a limit. */
export function planHasWindow(plan: Pick<CommissionPlan, 'percentBps' | 'windowMonths'>): boolean {
  return plan.percentBps > 0 && plan.windowMonths !== null;
}

export interface NoticeCustomer {
  id: string;
  windowNoticeSentAt: Date | null;
}

export interface DueNotice {
  customerId: string;
  endsAt: Date;
}

/**
 * The customers of ONE partner whose window notice is due now, soonest end
 * first. `evaluation` is the engine's answer for the partner's whole payment
 * history under `plan`.
 */
export function dueWindowNotices(input: {
  plan: CommissionPlan;
  partner: PartnerFacts;
  evaluation: PartnerEvaluation;
  customers: readonly NoticeCustomer[];
  now: Date;
  leadDays: number;
}): DueNotice[] {
  const { plan, partner, evaluation, now, leadDays } = input;
  if (!planHasWindow(plan) || leadDays <= 0) return [];
  // Before the switch every customer earns its one-off tier only: no window
  // decides anything yet, so there is nothing to announce.
  if (evaluation.switchedAt === null) return [];

  // The engine's window end per customer (the same value on every payment of an
  // eligible customer; an invalid payment carries null and is skipped).
  const endsAtOf = new Map<string, Date>();
  for (const p of evaluation.payments) {
    if (p.windowEndsAt !== null && p.customerOrdinal !== null && !endsAtOf.has(p.customerId)) endsAtOf.set(p.customerId, p.windowEndsAt);
  }

  const stopsAt = plan.afterNotice === 'STOP_ALL' ? (partner.noticeEffectiveAt?.getTime() ?? null) : null;
  const due: DueNotice[] = [];
  for (const c of input.customers) {
    const endsAt = endsAtOf.get(c.id) ?? null;
    if (!windowNoticeDue({ endsAt, now, leadDays, sentAt: c.windowNoticeSentAt })) continue;
    // STOP_ALL: the termination ends the earning first; the window end is moot.
    if (stopsAt !== null && stopsAt < endsAt!.getTime()) continue;
    due.push({ customerId: c.id, endsAt: endsAt! });
  }
  return due.sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime() || (a.customerId < b.customerId ? -1 : 1));
}
