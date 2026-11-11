// The tenant welcome page — the database half (#1664). The rules (what counts
// as a welcome, how the body becomes text) are pure in ./tenantWelcomeRule.ts.
//
// WHOSE PAGE. Only an org whose ownership of this host is PROVEN gets to greet
// people on it: resolveOrgFromHost() (src/lib/hostOrg.ts, #1661) answers a
// DNS-verified `publicHost` or a `<slug>.<APP_ROOT_DOMAIN>` host and nothing
// else. An operator mapping that is not verified yet keeps our landing. A host
// we serve ourselves (servedHosts()) is never a tenant's, so the most-hit page
// in the app asks the database nothing for it.
//
// SERVER-ONLY (Prisma). Failing is the landing page: a public page must render.

import { prisma } from '@/lib/prisma';
import { resolveOrgFromHost } from '@/lib/hostOrg';
import { isServedHost } from '@/lib/servedHosts';
import { getOrgBranding } from '@/lib/orgBranding';
import { productNameFor, verticalHasCapability } from '@/lib/verticals';
import { logger } from '@/lib/logger';
import { hasWelcome } from '@/lib/tenantWelcomeRule';

export interface TenantWelcome {
  orgId: string;
  title: string;
  body: string | null;
  brandName: string;
  logoUrl: string | null;
  color: string | null;
  /** Whether the org's product has a public mentee application (`/apply`). */
  canApply: boolean;
  /** Our product's name for the org's vertical — the "powered by" line, never the tenant's brand. */
  product: string;
}

/** The welcome page the request's host should show at `/`, or null for the normal landing. */
export async function tenantWelcomeFor(hostHeader: string | null | undefined): Promise<TenantWelcome | null> {
  if (!hostHeader || isServedHost(hostHeader)) return null;
  try {
    const org = await resolveOrgFromHost(hostHeader);
    if (!org) return null;
    const row = await prisma.organization.findUnique({
      where: { id: org.id },
      select: { welcomeTitle: true, welcomeBody: true, vertical: true },
    });
    if (!row || !hasWelcome(row)) return null;
    const brand = await getOrgBranding(org.id);
    return {
      orgId: org.id,
      title: row.welcomeTitle!.trim(),
      body: row.welcomeBody,
      brandName: brand.name,
      logoUrl: brand.logoUrl,
      color: brand.color,
      canApply: verticalHasCapability(row.vertical, 'mentorship'),
      product: productNameFor(row.vertical),
    };
  } catch (e) {
    logger.warning('tenant_welcome.lookup_failed', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
