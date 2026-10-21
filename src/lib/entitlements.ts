import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { PREMIUM_FEATURES, type PremiumFeature } from '@/lib/entitlementsCatalog';
import { resolveOrgEntitlements } from '@/lib/subscription';

// Premium / freemium entitlements (EPIC #517). DB-backed helpers; the pure
// feature catalogue lives in entitlementsCatalog.ts (client-safe).
//
// The mentor and mentee experience is ALWAYS free and is never gated by this
// module. Nothing a mentor or mentee touches may call `entitled()`.
//
// ONE QUESTION, ONE ANSWER (#1733). There used to be three gates — a per-company
// `CompanyEntitlement` row, the org's plan, and a global `premiumAnalytics`
// setting — and each call site picked one. `entitled(orgId, feature)` is now the
// only question a gate asks; it reads the org's subscription plan and its
// unexpired `OrgEntitlement` grants through src/lib/subscription.ts (the one
// door to billing data). `hasFeature(companyId, …)` survives as a shim over it,
// so the existing company-side call sites did not have to change.
export { PREMIUM_FEATURES, isPremiumFeature, type PremiumFeature } from '@/lib/entitlementsCatalog';

/**
 * May this tenant use a paid feature? Resolution order:
 *   1. no org → **false**. Fail closed: a request that cannot name its tenant
 *      must never be the one that unlocks the paid product;
 *   2. the org's subscription plan includes it (while its status carries the
 *      plan — TRIALING / ACTIVE / PAST_DUE), or
 *   3. an `OrgEntitlement` grant for it that has not expired → true;
 *   4. otherwise false.
 * Steps 2–3 are `resolveOrgEntitlements()`; this adds only step 1.
 */
export async function entitled(orgId: string | null | undefined, feature: PremiumFeature, now: Date = new Date()): Promise<boolean> {
  if (!orgId) return false;
  return (await resolveOrgEntitlements(orgId, now)).features.includes(feature);
}

/**
 * Every paid feature the tenant may use, for a screen that needs the whole map
 * instead of one answer (one subscription read + one grant read). Empty for no
 * org, by the same fail-closed rule as `entitled()`.
 */
export async function entitledFeatures(orgId: string | null | undefined, now: Date = new Date()): Promise<Set<PremiumFeature>> {
  if (!orgId) return new Set();
  return new Set((await resolveOrgEntitlements(orgId, now)).features);
}

// Legacy fallbacks already reported in this process — logged once each, so the
// log answers "is any company still living on a CompanyEntitlement row?"
// without repeating it on every request.
const reportedLegacy = new Set<string>();

/**
 * Is a premium feature enabled for a company? A COMPATIBILITY SHIM (#1733):
 * the company's org decides, through `entitled()`.
 *
 * Grandfathering: a per-company `CompanyEntitlement` row — the only mechanism
 * before plans existed — still grants the feature when the org's plan does not,
 * so nobody loses access they were given by hand. Each such fallback is logged
 * once at `info`; when the log goes quiet, the rows (and this branch) can go.
 *
 * A missing company, or a company with no org and no legacy row, is simply
 * false — never a 500.
 */
export async function hasFeature(companyId: string | null | undefined, feature: PremiumFeature): Promise<boolean> {
  if (!companyId) return false;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { orgId: true } });
  if (!company) return false;
  if (await entitled(company.orgId, feature)) return true;
  const legacy = await prisma.companyEntitlement.findUnique({
    where: { companyId_feature: { companyId, feature } },
    select: { id: true },
  });
  if (!legacy) return false;
  const key = `${companyId}:${feature}`;
  if (!reportedLegacy.has(key)) {
    reportedLegacy.add(key);
    logger.info('entitlement granted by a legacy CompanyEntitlement row', { companyId, feature, orgId: company.orgId ?? undefined });
  }
  return true;
}

/** Where a company's access to one feature comes from — what the admin grid shows. */
export interface FeatureSource {
  /** The resolved answer: what `hasFeature()` would say. */
  enabled: boolean;
  /** Included in the org's plan or granted to the org (`entitled()`). */
  fromPlan: boolean;
  /** A per-company CompanyEntitlement row exists (the legacy override). */
  override: boolean;
}

/** Per feature: resolved access and where it comes from. Two reads plus the org's entitlement pair. */
export async function getCompanyFeatureSources(companyId: string): Promise<Record<PremiumFeature, FeatureSource>> {
  const [company, rows] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { orgId: true } }),
    prisma.companyEntitlement.findMany({ where: { companyId }, select: { feature: true } }),
  ]);
  const overrides = new Set(rows.map((r) => r.feature));
  const fromOrg = await entitledFeatures(company?.orgId);
  const out = {} as Record<PremiumFeature, FeatureSource>;
  for (const f of PREMIUM_FEATURES) {
    const fromPlan = fromOrg.has(f.key);
    const override = overrides.has(f.key);
    out[f.key] = { enabled: fromPlan || override, fromPlan, override };
  }
  return out;
}

// The RESOLVED feature map for a company ({ key: boolean } over every known
// feature): org plan/grants OR a legacy company row — the same answer
// hasFeature() gives, feature by feature.
export async function getCompanyFeatures(companyId: string): Promise<Record<PremiumFeature, boolean>> {
  const sources = await getCompanyFeatureSources(companyId);
  const out = {} as Record<PremiumFeature, boolean>;
  for (const f of PREMIUM_FEATURES) out[f.key] = sources[f.key].enabled;
  return out;
}
