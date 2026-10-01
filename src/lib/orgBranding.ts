import { prisma } from '@/lib/prisma';
import { resolveBranding, type ResolvedBranding } from '@/lib/branding';
import { DEFAULT_VERTICAL, toVerticalKey, type VerticalKey } from '@/lib/verticals';

// The org's world rides along because the same read already has it, and a mail
// needs it for the defaults a tenant left unset (sender name, accent colour).
// No org is the default world (docs/worlds.md).
export type OrgBranding = ResolvedBranding & { vertical: VerticalKey };

// Server-side: resolve a tenant's white-label branding (#546) for the given org,
// falling back to the product defaults when the org has no overrides (or no org
// — single-tenant / not signed in). Cheap single-row lookup.
export async function getOrgBranding(
  orgId: string | null | undefined,
  // Name to use when there is NO org (signed-out) instead of the product default
  // (#2498). Lets a marketing host's public wordmark read its own product name
  // rather than "Internship CRM". Ignored once an org is resolved — a signed-in
  // tenant's own brandName always wins.
  noOrgFallbackName?: string | null,
): Promise<OrgBranding> {
  if (!orgId) return { ...resolveBranding(null, noOrgFallbackName), vertical: DEFAULT_VERTICAL };
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { brandName: true, brandLogoUrl: true, brandColor: true, supportEmail: true, vertical: true, name: true },
  });
  // A non-INTERNSHIP vertical is a different product, so its unbranded fallback
  // is the org's own name — never "Internship CRM" (#2355 follow-up). INTERNSHIP
  // keeps the product default.
  const fallbackName = org && org.vertical && org.vertical !== 'INTERNSHIP' ? org.name : undefined;
  return { ...resolveBranding(org, fallbackName), vertical: toVerticalKey(org?.vertical) };
}
