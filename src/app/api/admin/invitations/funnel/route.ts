import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { requirePermission } from '@/lib/authz';
import { loadInvitationFunnel } from '@/lib/invitationFunnel';

// GET /api/admin/invitations/funnel?from=&to= (#1921)
//
// sent → opened → registered → activated for the invitations sent in the
// range, in total, per role and per inviter. Same gate and the same hand-written
// tenant filter as the status board beside it (../route.ts): the rows name
// people who have no account yet, so only an admin reads them. The stages and
// what "activated" means live in src/lib/invitationFunnelRule.ts.

/** The per-inviter table shows the busiest; the rest are in the total. */
const INVITER_LIMIT = 50;

export async function GET(request: Request) {
  const gate = await requirePermission('user.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const url = new URL(request.url);

  return await withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const funnel = await loadInvitationFunnel(tenant, {
      from: rangeStart(url.searchParams.get('from')),
      to: rangeEnd(url.searchParams.get('to')),
    });
    const inviters = funnel.byInviter.slice(0, INVITER_LIMIT);
    const ids = inviters.map((i) => i.invitedById).filter((id): id is string => !!id);
    const names = new Map(
      (ids.length ? await prisma.user.findMany({ where: withinTenant({ id: { in: ids } }, tenant), select: { id: true, fullName: true } }) : []).map(
        (u) => [u.id, u.fullName],
      ),
    );
    return NextResponse.json({
      total: funnel.total,
      byRole: funnel.byRole,
      // An inviter who left the org (or a system invite) has no name: null.
      byInviter: inviters.map((i) => ({ ...i, inviterName: (i.invitedById && names.get(i.invitedById)) || null })),
      revoked: funnel.revoked,
    });
  });
}
