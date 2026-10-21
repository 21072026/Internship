// One reader for "why was this refused, and what lifts it?" (#1745).
//
// Every paywall in the product answers with one of two 403 shapes — the plan
// gate's `plan_limit_reached` (src/lib/planGate.ts) and the entitlement gate's
// `feature_locked` — and every screen that meets one renders <UpgradePrompt>
// from the parsed body. The parse reads the CODE and the numbers, never the
// server's English `error` text: that string is for logs and API consumers,
// and a screen that shows (or string-matches) it shows English to a Turkish
// admin.
//
// CLIENT-SAFE AND PURE: prices and packaging come from src/lib/plans.ts, the
// one source the pricing page reads too, so the prompt can never quote a
// figure the pricing page does not.

import {
  ADDONS,
  LEGACY_PLAN_MAP,
  PLANS,
  annualMonthlyEur,
  getPlan,
  planIncludingFeature,
  type PlanAudience,
  type PlanKey,
} from '@/lib/plans';
import { isPremiumFeature, type PremiumFeature } from '@/lib/entitlementsCatalog';

export type GateCode = 'plan_limit_reached' | 'feature_locked';

export interface GateError {
  code: GateCode;
  // plan_limit_reached: the cap that was hit and how much of it is used.
  limit?: number | null;
  usage?: number | null;
  // The plan the tenant is on, as the gate named it (legacy FREE/PRO/ENTERPRISE
  // or a plan key) — used to find the next plan up, never displayed raw.
  plan?: string | null;
  // feature_locked: which feature.
  feature?: PremiumFeature;
  // True when the server already told the org's admins (a mentor hit the cap).
  adminsNotified?: boolean;
}

/** The typed gate error in a parsed 403 body, or null for any other body. */
export function parseGateBody(body: unknown): GateError | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (b.code === 'plan_limit_reached') {
    return {
      code: 'plan_limit_reached',
      limit: num(b.limit),
      usage: num(b.usage),
      plan: typeof b.plan === 'string' ? b.plan : null,
      adminsNotified: b.adminsNotified === true,
    };
  }
  if (b.code === 'feature_locked') {
    return {
      code: 'feature_locked',
      feature: isPremiumFeature(b.feature) ? b.feature : undefined,
      plan: typeof b.plan === 'string' ? b.plan : null,
      adminsNotified: b.adminsNotified === true,
    };
  }
  return null;
}

/**
 * Read a fetch Response: the gate error when it is a 403 carrying one, else
 * null. Reads a CLONE, so the caller can still consume the body itself.
 */
export async function parseGateError(res: Response): Promise<GateError | null> {
  if (res.status !== 403) return null;
  const body = await res.clone().json().catch(() => null);
  return parseGateBody(body);
}

export type Lift =
  // A plan sells it: its published name and its headline monthly price (the
  // annual total / 12, which is what the pricing column prints).
  | { kind: 'plan'; planKey: PlanKey; name: string; monthlyEur: number | null; requestable: boolean }
  // Sold only as an add-on (the AI pack).
  | { kind: 'addon'; addonKey: string; monthlyEur: number }
  // Nothing published lifts it — contact us.
  | { kind: 'contact' };

function planKeyOf(plan: string | null | undefined): PlanKey | null {
  if (!plan) return null;
  if (plan in LEGACY_PLAN_MAP) return LEGACY_PLAN_MAP[plan as keyof typeof LEGACY_PLAN_MAP];
  return getPlan(plan)?.key ?? null;
}

function liftPlan(key: PlanKey): Lift {
  const plan = getPlan(key)!;
  return {
    kind: 'plan',
    planKey: key,
    name: plan.name,
    monthlyEur: annualMonthlyEur(key),
    // A tenant admin can request a programme plan (POST /api/org/plan-change,
    // src/lib/planChangeRule.ts); an employer plan is bought by the company.
    requestable: plan.audience === 'PROGRAM',
  };
}

/**
 * What lifts this refusal. `audience` says whose wallet the screen belongs to
 * (a company's talent pool is EMPLOYER; everything else is the programme's).
 */
export function liftFor(gate: GateError, audience: PlanAudience = 'PROGRAM'): Lift {
  if (gate.code === 'feature_locked') {
    if (!gate.feature) return { kind: 'contact' };
    const key = planIncludingFeature(gate.feature, audience) ?? (audience === 'PROGRAM' ? null : planIncludingFeature(gate.feature, 'PROGRAM'));
    if (key) return liftPlan(key);
    const addon = ADDONS.find((a) => a.grants === gate.feature);
    if (addon && addon.billing === 'PER_MONTH') return { kind: 'addon', addonKey: addon.key, monthlyEur: addon.priceEur };
    return { kind: 'contact' };
  }
  // plan_limit_reached: the next programme plan, after the current one, whose
  // band is larger than the cap that was hit (null = unlimited).
  const current = planKeyOf(gate.plan);
  const ladder = PLANS.filter((p) => p.audience === 'PROGRAM');
  const from = current ? ladder.findIndex((p) => p.key === current) : -1;
  const limit = gate.limit ?? 0;
  const next = ladder.slice(from + 1).find((p) => p.limits.activePairs == null || p.limits.activePairs > limit);
  return next ? liftPlan(next.key) : { kind: 'contact' };
}
