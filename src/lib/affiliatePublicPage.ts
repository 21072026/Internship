// The public partner-programme page's data (docs/affiliate-module.md, #3360).
// Server-only (Prisma, request headers).
//
// WHICH ORGANISATION. The page is signed out, so the host decides — through the
// same resolver as the public company-inquiry form (src/lib/publicHostOrg.ts,
// #2569): the org an operator mapped this hostname to, MARKETING only. Its
// trust note applies unchanged: the page shows what that org chose to publish
// (its own marketing copy and its commission table) and reads nothing private,
// so a forged host header can at most show the forger another tenant's public
// page.
//
// WHEN IT EXISTS. Only for an org whose vertical has the `affiliate`
// capability, with a valid commission plan and some landing copy: anything less
// is a 404, never a half-empty page. The table comes from the plan itself, so
// the page can never promise what the engine does not pay.

import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { requestHostHeader, resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { parseCommissionPlan, type CommissionPlan } from '@/lib/affiliateCommissionRule';
import { landingHasContent, readStoredLanding, type Landing } from '@/lib/affiliateLandingRule';

export interface PublicProgramme {
  orgId: string;
  landing: Landing;
  plan: CommissionPlan;
}

/**
 * The org whose partner programme this host serves — MARKETING, `affiliate`
 * capability, a valid plan — with its settings row, or null. Shared by the page
 * and the public application route (#3361), which reads the host from the request.
 */
export async function affiliateProgrammeForHost(
  hostHeader: string | null | undefined,
): Promise<{ orgId: string; plan: CommissionPlan; landing: unknown } | null> {
  const target = await resolvePublicInquiryTarget(hostHeader);
  if (!target.open || target.vertical !== 'MARKETING' || !target.orgId) return null;
  const orgId = target.orgId;
  if (!(await shellCapabilities(orgId)).includes('affiliate')) return null;
  // Sessionless: no tenant context is bound, so the org is named explicitly.
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true, landing: true } });
  if (!settings?.plan) return null;
  const plan = parseCommissionPlan(settings.plan);
  return plan.ok ? { orgId, plan: plan.plan, landing: settings.landing } : null;
}

/** The programme this request's host publishes, or null (render a 404). */
export async function publicProgrammeForRequest(): Promise<PublicProgramme | null> {
  const programme = await affiliateProgrammeForHost(requestHostHeader(await headers()));
  if (!programme) return null;
  const landing = readStoredLanding(programme.landing);
  if (!landingHasContent(landing)) return null;
  return { orgId: programme.orgId, landing, plan: programme.plan };
}
