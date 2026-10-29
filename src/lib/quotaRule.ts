// Provisioning quotas (#1752) — the rule, dependency-free apart from the plan
// catalogue and unit-tested (scripts/test/quota-rule.test.mjs). The database
// half is src/lib/quota.ts.
//
// FREE CORE, the line this file exists to hold: only ADMIN seats are a seat
// meter. Inviting, registering or provisioning a MENTOR or a MENTEE is never
// checked and never counted — there is deliberately no metric for them here,
// so no caller can ask.
//
// Point-in-time capacity, like the relation cap in src/lib/planGate.ts: one
// more object may be created while usage + adding <= limit. Nothing existing
// is ever cut: a quota refuses the NEXT write, it never revokes a row.

import type { PlanLimits } from './plans';

export const QUOTA_METRICS = ['ADMIN_SEATS', 'COMPANIES', 'PROGRAMS'] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

/** Which plan limit each quota reads. */
export const QUOTA_LIMIT_KEY: Record<QuotaMetric, keyof PlanLimits> = {
  ADMIN_SEATS: 'adminSeats',
  COMPANIES: 'companies',
  PROGRAMS: 'programs',
};

export interface QuotaResult {
  allowed: boolean;
  metric: QuotaMetric;
  /** The subscription's plan key, or null when no plan applies (fail-open). */
  plan: string | null;
  limit: number | null;
  usage: number;
}

/** May `adding` more be provisioned? A null limit is unlimited. */
export function quotaAllows(limit: number | null, usage: number, adding = 1): boolean {
  return limit === null || usage + Math.max(0, adding) <= limit;
}

/**
 * The machine-readable 403, the same `plan_limit_reached` shape as the relation
 * gate plus the `metric`, so the one upgrade prompt (#1745) renders every gate.
 * The English `error` is for logs and API consumers only; no screen shows it.
 */
export function quotaError(result: QuotaResult) {
  return {
    error: `Plan limit reached: ${result.usage}/${result.limit} ${result.metric} on the ${result.plan} plan. Nothing existing is affected — upgrade to add more.`,
    code: 'plan_limit_reached' as const,
    metric: result.metric,
    limit: result.limit,
    usage: result.usage,
    plan: result.plan,
  };
}
