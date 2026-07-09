import { prisma } from '@/lib/prisma';
import { PREMIUM_FEATURES, type PremiumFeature } from '@/lib/entitlementsCatalog';

// Premium / freemium entitlements (EPIC #517, Faz 0). DB-backed helpers; the
// pure feature catalogue lives in entitlementsCatalog.ts (client-safe).
//
// The mentor and mentee experience is ALWAYS free and is never gated by this
// module. Entitlements only unlock optional COMPANY-facing premium features.
// A feature is "on" for a company when a CompanyEntitlement row exists for it;
// nothing is enabled by default, so the free core is preserved.

export { PREMIUM_FEATURES, isPremiumFeature, type PremiumFeature } from '@/lib/entitlementsCatalog';

// Is a specific premium feature enabled for a company? Null/absent company →
// false. Safe to call on every request; a single indexed lookup.
export async function hasFeature(companyId: string | null | undefined, feature: PremiumFeature): Promise<boolean> {
  if (!companyId) return false;
  const row = await prisma.companyEntitlement.findUnique({
    where: { companyId_feature: { companyId, feature } },
    select: { id: true },
  });
  return !!row;
}

// The set of enabled features for a company, as a { key: boolean } map covering
// every known feature (so the admin UI can render all toggles).
export async function getCompanyFeatures(companyId: string): Promise<Record<PremiumFeature, boolean>> {
  const rows = await prisma.companyEntitlement.findMany({
    where: { companyId },
    select: { feature: true },
  });
  const enabled = new Set(rows.map((r) => r.feature));
  const out = {} as Record<PremiumFeature, boolean>;
  for (const f of PREMIUM_FEATURES) out[f.key] = enabled.has(f.key);
  return out;
}

// Enable/disable one feature for a company (idempotent).
export async function setCompanyFeature(companyId: string, feature: PremiumFeature, enabled: boolean): Promise<void> {
  if (enabled) {
    await prisma.companyEntitlement.upsert({
      where: { companyId_feature: { companyId, feature } },
      create: { companyId, feature },
      update: {},
    });
  } else {
    await prisma.companyEntitlement.deleteMany({ where: { companyId, feature } });
  }
}
