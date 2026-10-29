import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { affiliateOverview } from '@/lib/affiliateOverview';

// GET — the programme's overview (docs/affiliate-module.md, #3173): partners by
// state, customers, commission totals per status, payouts and the latest one,
// and which setup steps are done. `affiliate.read` (OBSERVER included); a fixed
// number of queries whatever the programme's size.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;
  return NextResponse.json(await affiliateOverview(orgId));
}
