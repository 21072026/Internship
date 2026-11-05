// The invitation funnel's loader (#1921). Server-only: the rule itself is pure
// in invitationFunnelRule.ts; this reads the rows it judges.
//
// "Activated" has no column of its own. It is read from the account the
// invitation produced: an account in the invitation's org, with the address the
// registration wrote back onto the row, that has `lastLoginAt` set. The org pins
// the world (`User.email` is unique per org, docs/worlds.md), so the lookup can
// never pick up the same person's account in the other product.

import { prisma } from '@/lib/prisma';
import { defaultOrgId } from '@/lib/defaultOrg';
import { orgWhere, withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { invitationFunnel, type FunnelInvitation, type InvitationFunnel } from '@/lib/invitationFunnelRule';

export interface FunnelRange {
  from?: Date | null;
  to?: Date | null;
}

/** The funnel of every invitation SENT in the range (by `createdAt`), inside the tenant. */
export async function loadInvitationFunnel(tenant: TenantWhere, range: FunnelRange = {}): Promise<InvitationFunnel> {
  const createdAt = { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) };
  const rows = await prisma.invitationToken.findMany({
    where: withinTenant(range.from || range.to ? { createdAt } : {}, tenant),
    select: { role: true, openedAt: true, registeredAt: true, used: true, revokedAt: true, email: true, orgId: true },
  });

  // Who of the registered invitees has signed in, one query per org involved
  // (one in practice: a tenant's own, plus the NULL rows the default org owns).
  const fallback = await defaultOrgId();
  const registeredByOrg = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.email || !(r.registeredAt || r.used)) continue;
    const org = r.orgId ?? fallback;
    if (!registeredByOrg.has(org)) registeredByOrg.set(org, new Set());
    registeredByOrg.get(org)!.add(r.email.toLowerCase());
  }
  const activated = new Set<string>();
  for (const [org, emails] of registeredByOrg) {
    const users = await prisma.user.findMany({
      where: withinTenant({ email: { in: [...emails] }, lastLoginAt: { not: null } }, await orgWhere(org)),
      select: { email: true },
    });
    for (const u of users) activated.add(`${org}\u0000${u.email.toLowerCase()}`);
  }

  return invitationFunnel(
    rows.map(
      (r): FunnelInvitation => ({
        role: r.role,
        openedAt: r.openedAt,
        registeredAt: r.registeredAt,
        used: r.used,
        revokedAt: r.revokedAt,
        activated: !!r.email && activated.has(`${r.orgId ?? fallback}\u0000${r.email.toLowerCase()}`),
      }),
    ),
  );
}
