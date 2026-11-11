import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { breachOwners, listOpenBreaches } from '@/lib/slaQueue';

// The SLA breach queue (#1723): the open SlaBreach rows (#1722) of the
// caller's tenant, one page at a time, oldest deadline first. ADMIN only; the
// tenant comes from the session, never from the request. Free core — stage
// SLAs are deliberately not behind `premiumAnalytics` (see
// api/admin/stage-sla/route.ts).
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const sp = new URL(request.url).searchParams;
  const level = Number(sp.get('level'));
  const ack = sp.get('acknowledged');
  return await withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const [queue, owners] = await Promise.all([
      listOpenBreaches(tenant, {
        stage: sp.get('stage')?.slice(0, 64) || null,
        level: Number.isInteger(level) && level > 0 ? level : null,
        ownerId: sp.get('owner')?.slice(0, 64) || null,
        acknowledged: ack === 'yes' || ack === 'no' ? ack : null,
        q: sp.get('q')?.trim().slice(0, 100) || null,
        page: Number(sp.get('page')) || 1,
      }),
      breachOwners(tenant),
    ]);
    return NextResponse.json({ ...queue, owners });
  });
}
