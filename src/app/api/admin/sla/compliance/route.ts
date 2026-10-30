import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere } from '@/lib/tenantFilter';
import { slaCompliance } from '@/lib/slaQueue';

// The stage-SLA compliance rate (#1723): numerator, denominator and period,
// never a bare percentage. The definition is in src/lib/slaCompliance.ts and is
// printed beside the number. ADMIN only, tenant from the session, free core.
const ALLOWED_DAYS = new Set([30, 90, 180, 365]);

export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const asked = Number(new URL(request.url).searchParams.get('days'));
  const days = ALLOWED_DAYS.has(asked) ? asked : 90;
  return await withTenantScope(session, async () => {
    return NextResponse.json(await slaCompliance(resolveOrgId(session), await tenantWhere(session), days));
  });
}
