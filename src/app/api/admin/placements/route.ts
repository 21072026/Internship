import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { loadPlacements, placementFiltersFrom } from '@/lib/placementQuery';

// GET /api/admin/placements (#1765) — the placement ledger: one row per hire,
// with its attribution and invoice state. Read with the same permission as the
// programme-cost ledger next to it (`analytics.read`); changing an invoice
// state is ORG_ADMIN only (`[id]/route.ts`).
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    const blocked = await requireCapability(orgId, 'placements');
    if (blocked) return blocked;
    const placements = await loadPlacements(orgId, placementFiltersFrom(new URL(request.url).searchParams));
    return NextResponse.json({ placements });
  });
}
