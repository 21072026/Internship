import { prisma } from '@/lib/prisma';
import { resolveBranding, type ResolvedBranding } from '@/lib/branding';

// Server-side: resolve a tenant's white-label branding (#546) for the given org,
// falling back to the product defaults when the org has no overrides (or no org
// — single-tenant / not signed in). Cheap single-row lookup.
export async function getOrgBranding(orgId: string | null | undefined): Promise<ResolvedBranding> {
  if (!orgId) return resolveBranding(null);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { brandName: true, brandLogoUrl: true, brandColor: true, supportEmail: true },
  });
  return resolveBranding(org);
}
