// Plan-limit enforcement gate (#547). Server-only (imports prisma), unlike the
// pure orgPlans catalogue which is client-safe.
//
// This turns the ADVISORY plan limits into a real gate at the "add a new active
// mentorship" chokepoints — WITHOUT ever touching existing data. Only the act of
// creating one more active relation is gated; current mentees/mentors always
// stay fully accessible (the core mentee/mentor loop is never hard-cut, per the
// premium model's non-negotiable rule).
//
// Safe for the live single-tenant install: the grandfathered "default" org is
// ENTERPRISE (maxActiveRelations = null = unlimited), so the gate is a no-op
// there. A null/unassigned org also fails open. It only bites FREE/PRO tenants.
//
// The count below is NOT the billing number, and the difference is deliberate
// (#1750): a plan cap is about CAPACITY ("you may not run more than 25 active
// mentorships"), so an idle pair still occupies a slot, while an invoice counts
// a month's USAGE and an idle pair is not billed. Both counts now come out of
// lib/metering.ts so the two definitions sit next to each other and neither can
// quietly become the other — `countActiveRelations` here, `activeMatchedPairs`
// for anything commercial.

import { countActiveRelations, countOrgProjects } from '@/lib/metering';
import { prisma } from '@/lib/prisma';
import { planLimits, isOrgPlan, type OrgPlan } from '@/lib/orgPlans';

export interface PlanGateResult {
  allowed: boolean;
  plan: OrgPlan | null;
  limit: number | null;
  usage: number;
}

// Can one more ACTIVE relation be added to this org under its plan?
// Fail-open when no org resolves or the plan is unlimited.
export async function checkActiveRelationLimit(orgId: string | null | undefined): Promise<PlanGateResult> {
  if (!orgId) return { allowed: true, plan: null, limit: null, usage: 0 };
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const plan = org && isOrgPlan(org.plan) ? org.plan : null;
  if (!plan) return { allowed: true, plan: null, limit: null, usage: 0 };

  const limit = planLimits(plan).maxActiveRelations;
  if (limit == null) return { allowed: true, plan, limit: null, usage: 0 };

  const usage = await countActiveRelations(orgId);
  return { allowed: usage < limit, plan, limit, usage };
}

// Resolve the tenant from the mentee, then check the active-relation limit.
export async function checkActiveRelationLimitForMentee(
  menteeId: string,
): Promise<PlanGateResult & { orgId: string | null }> {
  const mentee = await prisma.user.findUnique({ where: { id: menteeId }, select: { orgId: true } });
  const orgId = mentee?.orgId ?? null;
  return { ...(await checkActiveRelationLimit(orgId)), orgId };
}

// Can one more PROJECT be created in this org under its plan? (#2273)
//
// `maxProjects` has been declared in the plan catalogue since #547 and was read
// by exactly one thing: the usage gauge on /admin/organizations. So the number
// was displayed and never enforced — and #2270 opened project creation to the
// largest role population there is, which turned "unbounded growth per tenant"
// from theoretical into the default. The per-user rate limit added there is a
// BRAKE, not a quota: its default counter is an in-process Map that resets on
// redeploy and is not shared across replicas.
//
// Same two fail-open rules as the relation gate above: no org resolves, or the
// plan is unlimited (ENTERPRISE, so the grandfathered `default` org is a no-op
// here too) → allowed.
export async function checkProjectLimit(orgId: string | null | undefined): Promise<PlanGateResult> {
  if (!orgId) return { allowed: true, plan: null, limit: null, usage: 0 };
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const plan = org && isOrgPlan(org.plan) ? org.plan : null;
  if (!plan) return { allowed: true, plan: null, limit: null, usage: 0 };

  const limit = planLimits(plan).maxProjects;
  if (limit == null) return { allowed: true, plan, limit: null, usage: 0 };

  const usage = await countOrgProjects(orgId);
  return { allowed: usage < limit, plan, limit, usage };
}

// Standard 403 payload for a blocked add, so every call site returns the same
// machine-readable shape (code + limit/usage/plan) the UI can turn into an
// upgrade prompt.
export function planLimitError(gate: PlanGateResult) {
  return {
    error: `Plan limit reached: ${gate.usage}/${gate.limit} active mentorships on the ${gate.plan} plan. Existing mentees are unaffected — upgrade to add more.`,
    code: 'plan_limit_reached' as const,
    limit: gate.limit,
    usage: gate.usage,
    plan: gate.plan,
  };
}

// The same shape for the project cap, under its OWN code (#2273).
//
// Deliberately not reusing 'plan_limit_reached': `mentorshipAssignmentError`
// maps that code to a sentence about active mentorships, so a client that
// already reads it would translate a refused project into "you have too many
// mentees". A distinct code makes an unknown-code fallback the worst case
// instead of a confidently wrong message.
export function projectLimitError(gate: PlanGateResult) {
  return {
    error: `Plan limit reached: ${gate.usage}/${gate.limit} projects on the ${gate.plan} plan. Existing projects are unaffected — upgrade or archive one to add more.`,
    code: 'project_limit_reached' as const,
    limit: gate.limit,
    usage: gate.usage,
    plan: gate.plan,
  };
}
