import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { decide } from '@/lib/authzRule';
import { requireCapability } from '@/lib/capabilityGate';
import { COMMISSION_STATUSES, listCommissions, type CommissionStatus } from '@/lib/affiliateCommissions';

// GET — the programme's commissions (docs/affiliate-module.md, #3116), oldest due
// first, filtered by status and partner, paged, with totals per status summed in
// SQL. `affiliate.read`.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get('status');
  const status = (COMMISSION_STATUSES as readonly string[]).includes(rawStatus ?? '') ? (rawStatus as CommissionStatus) : null;
  const result = await listCommissions(orgId, { status, partnerId: url.searchParams.get('partnerId'), page: Number(url.searchParams.get('page') ?? 1) || 1 });
  return NextResponse.json({ ...result, canWrite: decide({ actor: auth.actor, permission: 'affiliate.write' }).allow });
}
