import { prisma } from '@/lib/prisma';
import { resolveBranding, type ResolvedBranding } from '@/lib/branding';

// Server-side: resolve a tenant's white-label branding (#546) for the given org,
// falling back to the product defaults when the org has no overrides (or no org
// — single-tenant / not signed in). Cheap single-row lookup.
export async function getOrgBranding(orgId: string | null | undefined): Promise<ResolvedBranding> {
  if (!orgId) return resolveBranding(null);
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { brandName: true, brandLogoUrl: true, brandColor: true, supportEmail: true, vertical: true, name: true },
  });
  // A non-INTERNSHIP vertical is a different product, so its unbranded fallback
  // is the org's own name — never "Internship CRM" (#2355 follow-up). INTERNSHIP
  // keeps the product default.
  const fallbackName = org && org.vertical && org.vertical !== 'INTERNSHIP' ? org.name : undefined;
  return resolveBranding(org, fallbackName);
}
