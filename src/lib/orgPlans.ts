// Per-tenant plan catalogue (#547). Pure data + helpers, no DB imports, so it
// is safe to import from client components (the admin org screen) as well as
// the server. The plan itself is stored on Organization.plan; the LIMITS that
// each plan implies live here, not in the DB, so pricing/packaging can change
// with a deploy instead of a migration.
//
// Limits are ADVISORY in this multi-tenancy phase: the admin screen surfaces
// usage vs. limit and flags over-limit tenants, but nothing hard-blocks
// creation yet (single-tenant prod runs on the grandfathered ENTERPRISE
// "default" org, which is unlimited). A later guarded slice can turn a chosen
// limit into a hard gate via isOverLimit().

export type OrgPlan = 'FREE' | 'PRO' | 'ENTERPRISE';

export interface OrgPlanLimits {
  // null = unlimited.
  maxUsers: number | null;
  maxActiveRelations: number | null;
  maxProjects: number | null;
}

export const ORG_PLANS: { key: OrgPlan; limits: OrgPlanLimits }[] = [
  { key: 'FREE', limits: { maxUsers: 25, maxActiveRelations: 25, maxProjects: 3 } },
  { key: 'PRO', limits: { maxUsers: 200, maxActiveRelations: 200, maxProjects: 25 } },
  { key: 'ENTERPRISE', limits: { maxUsers: null, maxActiveRelations: null, maxProjects: null } },
];

export const ORG_PLAN_KEYS = ORG_PLANS.map((p) => p.key);

const BY_KEY = new Map<OrgPlan, OrgPlanLimits>(ORG_PLANS.map((p) => [p.key, p.limits]));

export function isOrgPlan(value: unknown): value is OrgPlan {
  return typeof value === 'string' && BY_KEY.has(value as OrgPlan);
}

export function planLimits(plan: OrgPlan): OrgPlanLimits {
  return BY_KEY.get(plan) ?? ORG_PLANS[0].limits;
}

// Advisory check: is a given usage count at/over the plan's limit for a metric?
// Unlimited (null) is never over.
export function isOverLimit(plan: OrgPlan, metric: keyof OrgPlanLimits, usage: number): boolean {
  const limit = planLimits(plan)[metric];
  return limit != null && usage > limit;
}
