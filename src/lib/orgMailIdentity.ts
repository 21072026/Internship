import { cache } from 'react';
import { prisma } from '@/lib/prisma';
import { orgMailIdentity, platformFromIdentity, type MailIdentityTransport, type MailAddress } from '@/lib/orgMailIdentityRule';

// Request/render-scoped only: no process-wide TTL may retain revoked proof.
// Background sends outside a React request read fresh on every invocation.
const queryIdentity = (orgId: string) => prisma.organization.findUnique({
  where: { id: orgId },
  select: { brandName: true, publicHost: true, publicHostVerifiedAt: true,
    mailFromAddress: true, mailFromName: true, mailReplyTo: true, mailDomainVerifiedAt: true },
});
const readIdentity = cache(queryIdentity);

export async function resolveMailIdentity(orgId?: string | null, transport: MailIdentityTransport = 'primary', platformName?: string | null, platformFallback?: MailAddress, fresh = false) {
  const platform = platformFallback ?? platformFromIdentity(platformName, transport);
  if (!orgId) return orgMailIdentity(null, platform);
  try { return orgMailIdentity(await (fresh ? queryIdentity(orgId) : readIdentity(orgId)), platform); }
  catch { return orgMailIdentity(null, platform); } // DB failure must not authorize a tenant sender.
}

export async function tenantMailIdentityHealth(orgId?: string | null) {
  const [primary, bulk] = await Promise.all([resolveMailIdentity(orgId, 'primary'), resolveMailIdentity(orgId, 'bulk')]);
  return { source: primary.source, verifiedDomain: primary.verifiedDomain,
    mailDomainVerifiedAt: primary.mailDomainVerifiedAt,
    active: primary.source === 'tenant', primary: primary.from, bulk: bulk.from,
    replyTo: primary.replyTo ?? null };
}
