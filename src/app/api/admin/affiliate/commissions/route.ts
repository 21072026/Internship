import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { decide } from '@/lib/authzRule';
import { requireCapability } from '@/lib/capabilityGate';
import { listCommissions, type CommissionRow, type CommissionStatus } from '@/lib/affiliateCommissions';
import { COMMISSION_LIST, parseListQuery } from '@/lib/affiliateListQueryRule';

// GET — the programme's commissions (docs/affiliate-module.md, #3116), oldest due
// first by default, paged, with totals per status summed in SQL over the same
// filters. `affiliate.read`. Filters and sort (#3539): `partnerId`, `status`,
// `kind`, `from`/`to` (due days), `sort` = due | amount | partner, `dir`. A value
// outside the allowlist is a 400; another org's partner simply matches nothing.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = parseListQuery(COMMISSION_LIST, new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ code: 'invalid_query', field: parsed.field }, { status: 400 });
  const { status, kind, ...query } = parsed.query;
  const result = await listCommissions(orgId, { ...query, status: status as CommissionStatus | null, kind: kind as CommissionRow['kind'] | null });
  return NextResponse.json({ ...result, canWrite: decide({ actor: auth.actor, permission: 'affiliate.write' }).allow });
}
