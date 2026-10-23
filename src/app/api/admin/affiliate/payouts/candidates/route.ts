import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { approvedForPayout } from '@/lib/affiliateCommissions';
import { MAX_COMMISSIONS_PER_ACTION } from '@/lib/affiliatePaymentWriter';

// GET ?partnerId= — one partner's APPROVED commissions a payout can take: not
// paged, up to the per-payout limit, with the totals of all of them
// (docs/affiliate-module.md). `affiliate.write`: it is the payer's screen.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const partnerId = new URL(request.url).searchParams.get('partnerId');
  if (!partnerId) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  return NextResponse.json({ ...(await approvedForPayout(orgId, partnerId, MAX_COMMISSIONS_PER_ACTION)), max: MAX_COMMISSIONS_PER_ACTION });
}
