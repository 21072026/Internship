// Per-tenant SSO discovery (#1665): the host a person opened decides whose IdP
// the sign-in screens offer, so nobody has to type an organisation code.
//
// TRUST: the host is resolved ONLY through resolveOrgFromHost() (src/lib/
// hostOrg.ts) — a DNS-verified `publicHost`, or `<slug>.<APP_ROOT_DOMAIN>`.
// An unverified domain names no tenant, so pointing a domain at us does not
// make its IdP the login door. Discovery only decides which button is SHOWN;
// the login route re-checks everything (isSsoActive, the plan, the archive).
//
// WHAT IT DOES NOT CHANGE: the SP identifiers. SSO keeps its ONE registered
// endpoint (#2494) — the host the flow started on rides along in RelayState /
// the OIDC request row — so an IdP registration made before this keeps working.
//
// Never throws: a lookup failure is "no tenant", and the default screens render.
//
// Server-only.

import { prisma } from '@/lib/prisma';
import { resolveOrgFromHost } from '@/lib/hostOrg';
import { isSsoActive } from '@/lib/sso';

export interface TenantSso {
  slug: string;
  /** What the button says: the tenant's brand name, else its org name. */
  name: string;
  /** Organization.ssoEnforced (#1950) — passwords are refused server-side for non-exempt users. */
  enforced: boolean;
}

export async function discoverSsoForHost(hostHeader: string | null | undefined): Promise<TenantSso | null> {
  try {
    const hostOrg = await resolveOrgFromHost(hostHeader);
    if (!hostOrg) return null;
    const org = await prisma.organization.findUnique({ where: { id: hostOrg.id } });
    if (!org || org.archivedAt || !isSsoActive(org)) return null;
    return { slug: org.slug, name: org.brandName?.trim() || org.name, enforced: org.ssoEnforced };
  } catch {
    return null;
  }
}
