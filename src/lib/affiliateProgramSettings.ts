// The programme's settings: the commission plan (docs/affiliate-module.md, #3116)
// the referral base URL (#3117) and the public programme page's content (#3359).
// The ONE writer of AffiliateProgramSettings.plan / planVersion / planEffectiveAt /
// referralUrl / landing.
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
//     planEffectiveAt, writes an AuditLog row and a QUEUED re-evaluation state
//     in the same transaction,
//   - and then enqueues `affiliate.planResync` (#3170): the job re-evaluates every
//     partner through the payment writer, which freezes what exists and never pays
//     retroactively. The request returns once the plan is saved, whatever the
//     number of partners; the screen follows the job through `planResync`.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { parseCommissionPlan, type CommissionPlan, type PlanIssue } from '@/lib/affiliateCommissionRule';
import { enqueue } from '@/lib/jobs/queue';
import { PLAN_RESYNC_MAX_ATTEMPTS } from '@/lib/affiliatePlanResync';
import { parseResyncState, queuedResync, type PlanResyncState } from '@/lib/affiliatePlanResyncRule';
import { parseReferralUrl, type ReferralUrlIssue } from '@/lib/affiliateReferralRule';
import { canonicalLanding, parseLanding, readStoredLanding, type Landing, type LandingIssue } from '@/lib/affiliateLandingRule';

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
  /** The re-evaluation the change queued (null for an unchanged save). */
  resync: PlanResyncState | null;
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
        const planResync = queuedResync(1, now) as unknown as Prisma.InputJsonValue;
        await tx.affiliateProgramSettings.create({ data: { orgId, plan: value, planVersion: 1, planEffectiveAt: now, planResync } });
        next = 1;
      } else {
        next = current.planVersion + 1;
        const planResync = queuedResync(next, now) as unknown as Prisma.InputJsonValue;
        const { count } = await tx.affiliateProgramSettings.updateMany({
          where: { orgId, planVersion: current.planVersion },
          data: { plan: value, planVersion: next, planEffectiveAt: now, planResync },
        });
        if (count !== 1) throw new AffiliateSettingsError('conflict');
      }
      await tx.auditLog.create({
        data: { orgId, actorId, action: 'affiliate.plan.update', detail: JSON.stringify({ planVersion: next, currency: plan.currency }) },
      });
      return { changed: true, version: next };
    });
    if (!outcome.changed) return { changed: false, planVersion: outcome.version, resync: null };
    version = outcome.version;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AffiliateSettingsError('conflict');
    throw e;
  }

  // The plan is committed; the re-evaluation runs on the queue, keyed on the org
  // and the version, so a retried request enqueues it once. If the enqueue itself
  // fails, the state says INCOMPLETE: each partner is then re-evaluated by its next
  // payment write, as the writer always does — the save is not turned into an error.
  try {
    await enqueue('affiliate.planResync', { planVersion: version, actorId }, {
      orgId,
      idempotencyKey: `affiliate.planResync:${orgId}:${version}`,
      maxAttempts: PLAN_RESYNC_MAX_ATTEMPTS,
      trigger: 'manual',
    });
  } catch {
    const now = new Date();
    const failed: PlanResyncState = { ...queuedResync(version, now), status: 'INCOMPLETE', finishedAt: now.toISOString() };
    await prisma.affiliateProgramSettings.updateMany({ where: { orgId, planVersion: version }, data: { planResync: failed as unknown as Prisma.InputJsonValue } });
    return { changed: true, planVersion: version, resync: failed };
  }
  const stored = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { planResync: true } });
  return { changed: true, planVersion: version, resync: parseResyncState(stored?.planResync) };
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

/**
 * Replaces the public programme page's content (src/lib/affiliateLandingRule.ts).
 * An unchanged save writes nothing; a change is audited with the locales that
 * carry copy and whether each contact field is set — not the texts themselves,
 * which are the organisation's own marketing copy and live on the row.
 */
export async function saveLanding(
  orgId: string,
  raw: unknown,
  actorId: string,
): Promise<{ ok: true; landing: Landing; changed: boolean } | { ok: false; issues: LandingIssue[] }> {
  const parsed = parseLanding(raw);
  if (!parsed.ok) return parsed;
  const landing = parsed.landing;
  const value = landing as unknown as Prisma.InputJsonValue;
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.affiliateProgramSettings.findUnique({ where: { orgId }, select: { landing: true } });
      if (current && canonicalLanding(readStoredLanding(current.landing)) === canonicalLanding(landing)) {
        return { ok: true as const, landing, changed: false };
      }
      if (current) await tx.affiliateProgramSettings.update({ where: { orgId }, data: { landing: value } });
      else await tx.affiliateProgramSettings.create({ data: { orgId, landing: value } });
      await tx.auditLog.create({
        data: {
          orgId,
          actorId,
          action: 'affiliate.landing.update',
          detail: JSON.stringify({
            locales: Object.keys(landing.copy),
            phone: landing.phone !== null,
            email: landing.email !== null,
            productSignupUrl: landing.productSignupUrl !== null,
          }),
        },
      });
      return { ok: true as const, landing, changed: true };
    });
  } catch (e) {
    // Two first saves of one organisation: the loser hits the unique orgId.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AffiliateSettingsError('conflict');
    throw e;
  }
}

export async function programSettings(orgId: string) {
  const [settings, payments] = await Promise.all([
    prisma.affiliateProgramSettings.findUnique({
      where: { orgId },
      select: { plan: true, planVersion: true, planEffectiveAt: true, planResync: true, referralUrl: true, landing: true, contract: true, contractVersion: true, updatedAt: true },
    }),
    prisma.affiliatePayment.count({ where: { orgId } }),
  ]);
  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  return {
    plan: parsed?.ok ? parsed.plan : null,
    planVersion: settings?.planVersion ?? 0,
    planEffectiveAt: settings?.planEffectiveAt ?? null,
    planResync: parseResyncState(settings?.planResync),
    referralUrl: settings?.referralUrl ?? null,
    landing: readStoredLanding(settings?.landing),
    contract: settings?.contract ?? null,
    contractVersion: settings?.contractVersion ?? 0,
    currencyLocked: payments > 0,
    currencies: AFFILIATE_CURRENCIES,
  };
}
