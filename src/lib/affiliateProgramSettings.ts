// The programme's settings: the commission plan (docs/affiliate-module.md, #3116)
// and the referral base URL (#3117). The ONE writer of
// AffiliateProgramSettings.plan / planVersion / planEffectiveAt / referralUrl.
// The contract half has its own writer (src/lib/affiliateContract.ts).
//
// A plan change:
//   - is validated by the pure engine's parseCommissionPlan(), and the currency
//     must be one the programme offers — EUR only for now (a product decision;
//     the engine itself is currency-agnostic, so widening is this one list);
//   - is compared field by field in a fixed order, so an unchanged save keeps the
//     version (no needless re-evaluation, no audit noise);
//   - may not switch the currency once a payment exists: every past payment would
//     turn into "not a payment" and every ordinal would be rebuilt;
//   - bumps planVersion with a guarded update on the version it read, stamps
//     planEffectiveAt, writes an AuditLog row in the same transaction,
//   - and then re-evaluates every partner through the payment writer, which
//     freezes what exists and never pays retroactively.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { parseCommissionPlan, type CommissionPlan, type PlanIssue } from '@/lib/affiliateCommissionRule';
import { resyncPartnerCommissions } from '@/lib/affiliatePaymentWriter';
import { parseReferralUrl, type ReferralUrlIssue } from '@/lib/affiliateReferralRule';

/**
 * The currencies a programme may run in. EUR only in the first release; every
 * entry must be a two-decimal currency (src/lib/money.ts prints minor units as cents).
 */
export const AFFILIATE_CURRENCIES = ['EUR'] as const;

export type AffiliateSettingsErrorCode = 'invalid_plan' | 'currency_locked' | 'conflict';

export class AffiliateSettingsError extends Error {
  readonly code: AffiliateSettingsErrorCode;
  readonly issues: PlanIssue[];
  constructor(code: AffiliateSettingsErrorCode, issues: PlanIssue[] = []) {
    super(code);
    this.name = 'AffiliateSettingsError';
    this.code = code;
    this.issues = issues;
  }
}

/** The plan as one string with a fixed key order — the shape that is compared. */
export function canonicalPlan(plan: CommissionPlan): string {
  return JSON.stringify([
    plan.currency,
    plan.tiers.map((t) => [t.upToMinor, t.commissionMinor]),
    plan.topCommissionMinor,
    plan.percentBps,
    plan.switchAtCustomer,
    plan.boundaryCustomer,
    plan.windowMonths,
    plan.payoutDays,
    plan.afterNotice,
  ]);
}

export interface PlanSaveResult {
  changed: boolean;
  planVersion: number;
  partnersResynced: number;
  /** Partners whose re-evaluation failed (lock busy); their next payment write re-evaluates them. */
  resyncFailed: number;
  drift: number;
}

export async function savePlan(orgId: string, raw: unknown, actorId: string): Promise<PlanSaveResult> {
  const parsed = parseCommissionPlan(raw);
  if (!parsed.ok) throw new AffiliateSettingsError('invalid_plan', parsed.issues);
  const plan = parsed.plan;
  if (!(AFFILIATE_CURRENCIES as readonly string[]).includes(plan.currency)) {
    throw new AffiliateSettingsError('invalid_plan', [{ field: 'currency', code: 'range' }]);
  }

  let version: number;
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const current = await tx.affiliateProgramSettings.findUnique({
        where: { orgId },
        select: { plan: true, planVersion: true },
      });
      const stored = current?.plan ? parseCommissionPlan(current.plan) : null;
      if (stored?.ok && canonicalPlan(stored.plan) === canonicalPlan(plan)) {
        return { changed: false, version: current!.planVersion };
      }
      if (stored?.ok && stored.plan.currency !== plan.currency) {
        const payments = await tx.affiliatePayment.count({ where: { orgId } });
        if (payments > 0) throw new AffiliateSettingsError('currency_locked');
      }

      const value = plan as unknown as Prisma.InputJsonValue;
      const now = new Date();
      let next: number;
      if (!current) {
        await tx.affiliateProgramSettings.create({ data: { orgId, plan: value, planVersion: 1, planEffectiveAt: now } });
        next = 1;
      } else {
        next = current.planVersion + 1;
        const { count } = await tx.affiliateProgramSettings.updateMany({
          where: { orgId, planVersion: current.planVersion },
          data: { plan: value, planVersion: next, planEffectiveAt: now },
        });
        if (count !== 1) throw new AffiliateSettingsError('conflict');
      }
      await tx.auditLog.create({
        data: { orgId, actorId, action: 'affiliate.plan.update', detail: JSON.stringify({ planVersion: next, currency: plan.currency }) },
      });
      return { changed: true, version: next };
    });
    if (!outcome.changed) return { changed: false, planVersion: outcome.version, partnersResynced: 0, resyncFailed: 0, drift: 0 };
    version = outcome.version;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AffiliateSettingsError('conflict');
    throw e;
  }

  // Each partner in its own locked transaction (the writer's). Sequential on
  // purpose: a programme has few partners, and one lock at a time keeps the
  // database quiet for the payments being entered meanwhile.
  const partners = await prisma.affiliatePartner.findMany({ where: { orgId }, select: { id: true } });
  // The plan is already committed: a partner whose re-evaluation fails is counted
  // and reported, never turned into an error for a save that did happen.
  let drift = 0;
  let resynced = 0;
  let resyncFailed = 0;
  for (const p of partners) {
    try {
      drift += (await resyncPartnerCommissions(orgId, p.id, actorId)).drift.length;
      resynced += 1;
    } catch {
      resyncFailed += 1;
    }
  }
  return { changed: true, planVersion: version, partnersResynced: resynced, resyncFailed, drift };
}

/**
 * Sets the base URL partners' referral links are built on (null clears it). An
 * unchanged value writes nothing; a change is audited with the old and new value
 * (a URL of the organisation's own site, not a person's data).
 */
export async function saveReferralUrl(
  orgId: string,
  raw: unknown,
  actorId: string,
): Promise<{ ok: true; referralUrl: string | null; changed: boolean } | { ok: false; issue: ReferralUrlIssue }> {
  const parsed = parseReferralUrl(raw);
  if (!parsed.ok) return parsed;
  const referralUrl = parsed.url;
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.affiliateProgramSettings.findUnique({ where: { orgId }, select: { referralUrl: true } });
      if ((current?.referralUrl ?? null) === referralUrl) return { ok: true as const, referralUrl, changed: false };
      if (current) await tx.affiliateProgramSettings.update({ where: { orgId }, data: { referralUrl } });
      else await tx.affiliateProgramSettings.create({ data: { orgId, referralUrl } });
      await tx.auditLog.create({
        data: { orgId, actorId, action: 'affiliate.referral_url.update', detail: JSON.stringify({ from: current?.referralUrl ?? null, to: referralUrl }) },
      });
      return { ok: true as const, referralUrl, changed: true };
    });
  } catch (e) {
    // Two first saves of one organisation: the loser hits the unique orgId; the value is the winner's.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AffiliateSettingsError('conflict');
    throw e;
  }
}

export async function programSettings(orgId: string) {
  const [settings, payments] = await Promise.all([
    prisma.affiliateProgramSettings.findUnique({
      where: { orgId },
      select: { plan: true, planVersion: true, planEffectiveAt: true, referralUrl: true, contract: true, contractVersion: true, updatedAt: true },
    }),
    prisma.affiliatePayment.count({ where: { orgId } }),
  ]);
  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  return {
    plan: parsed?.ok ? parsed.plan : null,
    planVersion: settings?.planVersion ?? 0,
    planEffectiveAt: settings?.planEffectiveAt ?? null,
    referralUrl: settings?.referralUrl ?? null,
    contract: settings?.contract ?? null,
    contractVersion: settings?.contractVersion ?? 0,
    currencyLocked: payments > 0,
    currencies: AFFILIATE_CURRENCIES,
  };
}
