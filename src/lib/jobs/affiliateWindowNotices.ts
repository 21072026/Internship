// The `affiliate.windowNotices` job (#3556, docs/affiliate-module.md "Window notice").
//
// Once a day, for every programme whose plan has a percent window and whose
// notice is on (`AffiliateProgramSettings.windowNoticeDays` > 0), every partner
// hears — once per customer — that a customer's commission window ends within
// the lead time.
//
// WHAT IS *NOT* HERE. Which customers are due is src/lib/affiliateWindowNoticeRule.ts
// (pure, unit-tested), on the engine's own window end; the mail is
// src/lib/affiliateWindowNoticeMail.ts. This module loads the rows, claims and sends.
//
// CLAIM BEFORE SEND. Each due customer is claimed with ONE conditional update
// (`windowNoticeSentAt: null` in the WHERE) before the mail leaves, so a re-run
// — another replica, a retried job, an operator's manual run — finds nothing to
// claim and sends nothing. The price is the opposite failure: a mail that fails
// after its claim is not retried, and the partner still sees the date in the
// portal (#3557). The router's dedupe key (the partner and exactly the customers
// the mail names) additionally absorbs a retried send of the same claim.
//
// THE FIRST RUN. Nothing is backfilled. The rule only announces an end that is
// still ahead and within the lead time, so the first run on a populated
// database tells each partner about the customers whose window ends in the
// next `windowNoticeDays` — genuinely due news, not a backlog — and never about
// a window that has already closed.
//
// PER TENANT. There is no session: each programme is bound with `runWithOrg()`
// and every query names its `orgId` as well.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { runWithOrg } from '@/lib/orgContext';
import { MAX_AMOUNT_MINOR, customerWindowEndsAt, evaluatePartner, parseCommissionPlan, type CommissionPlan } from '@/lib/affiliateCommissionRule';
import { dueWindowNotices, planHasWindow, readWindowNoticeDays, windowNoticeDue } from '@/lib/affiliateWindowNoticeRule';
import { sendAffiliateWindowNotice, type WindowNoticeItem } from '@/lib/affiliateWindowNoticeMail';

/**
 * Partner mails sent in ONE run, across every programme. The rest is not
 * claimed and is picked up the next day: with a lead time of days, a customer
 * shed today is still ahead of its end tomorrow.
 */
export const WINDOW_NOTICE_MAX_PARTNERS_PER_RUN = 200;

export interface WindowNoticesResult {
  /** Programmes whose plan and setting made them eligible. */
  programmes: number;
  /** Customers whose window end fell in the lead time on the first-payment read. */
  considered: number;
  /** Customers claimed in this run (each named in exactly one mail). */
  claimed: number;
  /** Partner mails handed to the router. */
  mailed: number;
  /** Partners with due customers that were not told: no account, erased, suspended, or over the run's cap. */
  skipped: number;
  /** A programme or a partner whose work threw. */
  failed: number;
}

export async function runAffiliateWindowNotices(opts: { orgIds?: string[]; now?: Date } = {}): Promise<WindowNoticesResult> {
  const now = opts.now ?? new Date();
  const result: WindowNoticesResult = { programmes: 0, considered: 0, claimed: 0, mailed: 0, skipped: 0, failed: 0 };
  const settings = await prisma.affiliateProgramSettings.findMany({
    where: { windowNoticeDays: { gt: 0 }, ...(opts.orgIds ? { orgId: { in: opts.orgIds } } : {}) },
    select: { orgId: true, plan: true, windowNoticeDays: true },
    orderBy: { orgId: 'asc' },
  });

  for (const s of settings) {
    const parsed = s.plan ? parseCommissionPlan(s.plan) : null;
    if (!parsed?.ok || !planHasWindow(parsed.plan)) continue;
    const leadDays = readWindowNoticeDays(s.windowNoticeDays);
    if (leadDays <= 0) continue;
    result.programmes += 1;
    try {
      await runWithOrg(s.orgId, () => runProgramme(s.orgId, parsed.plan, leadDays, now, result));
    } catch (e) {
      result.failed += 1;
      logger.error('affiliate window notices: programme failed', { orgId: s.orgId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

async function runProgramme(orgId: string, plan: CommissionPlan, leadDays: number, now: Date, result: WindowNoticesResult) {
  // The first VALID payment per customer (the engine's own test: positive, in the
  // plan's currency) gives the window end exactly, so only customers whose end is
  // due are read further. The engine below still has the last word.
  const firsts = await prisma.affiliatePayment.groupBy({
    by: ['customerId'],
    where: { orgId, currency: plan.currency, amountMinor: { gt: 0, lte: MAX_AMOUNT_MINOR } },
    _min: { receivedAt: true },
  });
  const candidateIds = firsts
    .filter((f) => f._min.receivedAt && windowNoticeDue({ endsAt: customerWindowEndsAt(plan, f._min.receivedAt), now, leadDays, sentAt: null }))
    .map((f) => f.customerId);
  if (candidateIds.length === 0) return;

  const customers = await prisma.affiliateCustomer.findMany({
    where: { orgId, id: { in: candidateIds }, windowNoticeSentAt: null },
    select: { id: true, partnerId: true, externalRef: true, partnerLabel: true, windowNoticeSentAt: true },
  });
  result.considered += customers.length;
  const byPartner = new Map<string, typeof customers>();
  for (const c of customers) byPartner.set(c.partnerId, [...(byPartner.get(c.partnerId) ?? []), c]);

  for (const [partnerId, own] of [...byPartner.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (result.mailed >= WINDOW_NOTICE_MAX_PARTNERS_PER_RUN) {
      result.skipped += 1;
      continue;
    }
    try {
      await notifyPartner(orgId, plan, leadDays, now, partnerId, own, result);
    } catch (e) {
      result.failed += 1;
      logger.error('affiliate window notices: partner failed', { orgId, partnerId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

async function notifyPartner(
  orgId: string,
  plan: CommissionPlan,
  leadDays: number,
  now: Date,
  partnerId: string,
  customers: { id: string; externalRef: string; partnerLabel: string | null; windowNoticeSentAt: Date | null }[],
  result: WindowNoticesResult,
) {
  const partner = await prisma.affiliatePartner.findFirst({
    where: { id: partnerId, orgId },
    select: { status: true, noticeEffectiveAt: true, accountErasedAt: true, user: { select: { id: true, fullName: true, preferredLanguage: true } } },
  });
  // Nobody to tell: no portal account (yet), or an erased one. A SUSPENDED
  // partner records nothing new, so no window earns it anything while it stays
  // suspended. Nothing is claimed in any of these cases, so an account opened, or
  // a partnership reactivated, before the end still hears about it.
  if (!partner?.user || partner.accountErasedAt || partner.status === 'SUSPENDED') {
    result.skipped += 1;
    return;
  }
  const payments = await prisma.affiliatePayment.findMany({
    where: { orgId, customer: { partnerId } },
    select: { id: true, customerId: true, amountMinor: true, currency: true, receivedAt: true },
  });
  const facts = { noticeEffectiveAt: partner.noticeEffectiveAt };
  const due = dueWindowNotices({ plan, partner: facts, evaluation: evaluatePartner(plan, facts, payments), customers, now, leadDays });
  if (due.length === 0) return;

  const byId = new Map(customers.map((c) => [c.id, c]));
  const items: WindowNoticeItem[] = [];
  for (const d of due) {
    const { count } = await prisma.affiliateCustomer.updateMany({
      where: { id: d.customerId, orgId, windowNoticeSentAt: null },
      data: { windowNoticeSentAt: now },
    });
    if (count !== 1) continue; // another run claimed it first
    const c = byId.get(d.customerId)!;
    items.push({ customerId: c.id, name: c.partnerLabel ?? c.externalRef, endsAt: d.endsAt });
  }
  if (items.length === 0) return;
  result.claimed += items.length;
  await sendAffiliateWindowNotice({
    userId: partner.user.id,
    partnerId,
    fullName: partner.user.fullName,
    locale: partner.user.preferredLanguage,
    orgId,
    items,
  });
  result.mailed += 1;
}
