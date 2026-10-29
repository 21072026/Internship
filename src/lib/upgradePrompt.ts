// Reading a plan or entitlement 403 as a next step (#1745) — the one parser
// every fetch site uses, client-safe and dependency-free apart from the plan
// catalogue. It reads the body's `code` and the typed fields beside it, NEVER
// the `error` text: that string is English developer text for logs and API
// consumers, and a screen that matched on it would break the day it is
// reworded (and show a Turkish admin English in the meantime).
//
// FREE CORE: this is an operator surface. A participant (mentee) must never be
// handed a body this parser accepts — the one mentee-initiated gate,
// POST /api/apply, answers a capacity-shaped `program_full` instead.

import { isPremiumFeature, type PremiumFeature } from './entitlementsCatalog';
import { LEGACY_PLAN_MAP, PLANS, getPlan, planIncludingFeature, type PlanAudience, type PlanKey } from './plans';

/**
 * What a `plan_limit_reached` counts: the active-relation cap (planGate.ts, the
 * original and the default when a body names no metric) or one of the
 * provisioning quotas (#1752, src/lib/quotaRule.ts).
 */
export const GATE_METRICS = ['ACTIVE_PAIRS', 'ADMIN_SEATS', 'COMPANIES', 'PROGRAMS'] as const;
export type GateMetric = (typeof GATE_METRICS)[number];
const GATE_LIMIT_KEY: Record<GateMetric, 'activePairs' | 'adminSeats' | 'companies' | 'programs'> = {
  ACTIVE_PAIRS: 'activePairs',
  ADMIN_SEATS: 'adminSeats',
  COMPANIES: 'companies',
  PROGRAMS: 'programs',
};

export type GateInfo =
  | { code: 'plan_limit_reached'; metric: GateMetric; plan: string | null; limit: number | null; usage: number | null }
  | { code: 'feature_locked'; feature: PremiumFeature };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The typed gate of a parsed 403 body, or null when the body is not one. */
export function parseGateBody(body: unknown): GateInfo | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.code === 'plan_limit_reached') {
    const metric = (GATE_METRICS as readonly unknown[]).includes(b.metric) ? (b.metric as GateMetric) : 'ACTIVE_PAIRS';
    return { code: 'plan_limit_reached', metric, plan: typeof b.plan === 'string' ? b.plan : null, limit: num(b.limit), usage: num(b.usage) };
  }
  if (b.code === 'feature_locked' && isPremiumFeature(b.feature)) return { code: 'feature_locked', feature: b.feature };
  return null;
}

/** `parseGateBody` for a Response: only a 403 qualifies, and the body is read from a clone. */
export async function parseGateError(res: Response): Promise<GateInfo | null> {
  if (res.status !== 403) return null;
  try {
    return parseGateBody(await res.clone().json());
  } catch {
    return null;
  }
}

export type UpgradeOffer = {
  planKey: PlanKey;
  /** The published product name — the same in every locale. */
  planName: string;
  /** Whole EUR per year, or null when the plan is not sold yearly. */
  yearly: number | null;
  /** Whole EUR per month, or null when the plan is not sold monthly. */
  monthly: number | null;
};

function offerFor(key: PlanKey | null): UpgradeOffer | null {
  const plan = key ? getPlan(key) : null;
  if (!plan) return null;
  return { planKey: plan.key, planName: plan.name, yearly: plan.prices.YEARLY, monthly: plan.prices.MONTHLY };
}

/** The current plan's catalogue key, from a legacy `Organization.plan` value or a plan key. */
export function currentPlanKey(plan: string | null): PlanKey | null {
  if (!plan) return null;
  if (plan in LEGACY_PLAN_MAP) return LEGACY_PLAN_MAP[plan as keyof typeof LEGACY_PLAN_MAP];
  return getPlan(plan)?.key ?? null;
}

/**
 * The plan that lifts this gate, with its published price. For a cap: the
 * cheapest plan of the programme wallet with more of that metric (active pairs,
 * admin seats, companies, programmes) than the limit that was hit. For a
 * feature: the cheapest plan of the wallet that includes it (an add-on such as the AI pack has none — null, and the prompt
 * then offers the pricing page alone).
 */
export function upgradeOffer(gate: GateInfo, audience: PlanAudience = 'PROGRAM'): UpgradeOffer | null {
  if (gate.code === 'feature_locked') return offerFor(planIncludingFeature(gate.feature, audience));
  const limit = gate.limit;
  const key = GATE_LIMIT_KEY[gate.metric];
  const next = PLANS.find(
    (p) =>
      p.audience === 'PROGRAM' &&
      p.key !== currentPlanKey(gate.plan) &&
      (p.limits[key] === null || limit === null || (p.limits[key] as number) > limit),
  );
  return offerFor(next?.key ?? null);
}

/** A display name for the plan a 403 names: the catalogue name when it maps to one. */
export function planDisplayName(plan: string | null): string | null {
  const key = currentPlanKey(plan);
  return key ? getPlan(key)!.name : plan;
}
