import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { affiliateOverview } from '@/lib/affiliateOverview';
import { partnerFunnels } from '@/lib/affiliateFunnel';
import { funnelTotal } from '@/lib/affiliateFunnelBoardRule';

// GET — the programme's overview (docs/affiliate-module.md, #3173): partners by
// state, customers, commission totals per status, payouts and the latest one,
// and which setup steps are done. `affiliate.read` (OBSERVER included); a fixed
// number of queries whatever the programme's size. `funnel` is the org total of
// the shared partner funnel over the whole programme (#3544) — the Funnel tab's
// total row for "all", from the same query.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;
  const [overview, funnels] = await Promise.all([affiliateOverview(orgId), partnerFunnels(orgId, { period: 'all' })]);
  return NextResponse.json({ ...overview, funnel: funnelTotal(funnels.values()) });
}
