import { prisma } from '@/lib/prisma';
import { DEFAULT_BRANDING, resolveBranding, type ResolvedBranding } from '@/lib/branding';
import { PRODUCT } from '@/lib/product';

// The defaults a tenant's overrides fall back to on THIS deployment. The name
// comes from the product the container serves (src/lib/product.ts) rather than
// from a constant, so a marketing container says "SaleVali Marketing CRM" in
// its chrome, its transactional mail and its certificates without any of those
// call sites knowing that more than one product exists.
export const PRODUCT_BRANDING: ResolvedBranding = { ...DEFAULT_BRANDING, name: PRODUCT.name };

// Server-side: resolve a tenant's white-label branding (#546) for the given org,
// falling back to this deployment's product defaults when the org has no
// overrides (or no org — single-tenant / not signed in). Cheap single-row lookup.
export async function getOrgBranding(orgId: string | null | undefined): Promise<ResolvedBranding> {
  if (!orgId) return resolveBranding(null, PRODUCT_BRANDING);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { brandName: true, brandLogoUrl: true, brandColor: true, supportEmail: true },
  });
  return resolveBranding(org, PRODUCT_BRANDING);
}
