import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { driftReport } from '@/lib/affiliatePaymentWriter';

// GET — frozen commissions the current plan disagrees with (docs/affiliate-module.md):
// read only, nothing written. `affiliate.read`.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;
  return NextResponse.json({ drift: await driftReport(orgId) });
}
