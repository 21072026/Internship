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
//
// The plan ALSO decides which premium features a tenant may configure — see
// orgPlanHasFeature() at the bottom of this file (#1742).

import type { PremiumFeature } from '@/lib/entitlementsCatalog';

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

// --- Premium features by plan (#1742) -------------------------------------
//
// INTERIM source of truth. The real entitlement system (#1733's
// `entitled(orgId, feature)`, backed by the Subscription / OrgEntitlement
// tables of #1731) has not landed yet, and src/lib/entitlements.ts is
// COMPANY-scoped — the wrong axis for a tenant-level feature. Until #1733
// ships, the org's stored `plan` is the only per-tenant signal available, so
// this map is the single place that decides who may configure white-label
// branding or SAML SSO. When #1733 lands, this map is what gets deleted;
// nothing else needs to know how the answer was derived.
const PLAN_FEATURES: Record<OrgPlan, readonly PremiumFeature[]> = {
  FREE: [],
  PRO: ['WHITE_LABEL'],
  ENTERPRISE: ['WHITE_LABEL', 'SSO_SAML'],
};

// Does a plan include a premium feature? An unknown/absent plan is never
// entitled — a caller that cannot name the tenant's plan gets the free tier.
export function orgPlanHasFeature(plan: OrgPlan | string | null | undefined, feature: PremiumFeature): boolean {
  if (!isOrgPlan(plan)) return false;
  return PLAN_FEATURES[plan].includes(feature);
}
