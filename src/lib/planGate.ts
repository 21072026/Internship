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

  const usage = await prisma.mentorshipRelation.count({ where: { orgId, status: 'ACTIVE' } });
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
