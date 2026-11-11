import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { listUnmappedTerms } from '@/lib/skillQueue';
import { requirePermission } from '@/lib/authz';

// The skill backfill's review queue (#1819): free-text terms nothing in the
// org's vocabulary resolved, most frequent first. ADMIN only, checked here;
// the org comes from the session, never from the request.
const RESOLUTIONS = new Set(['PENDING', 'PROMOTED', 'ALIASED', 'DISCARDED']);

export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // The skill vocabulary feeds mentor and requisition matching — an internship module.
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ terms: [] });
    const requested = new URL(request.url).searchParams.get('resolution') ?? 'PENDING';
    const resolution = RESOLUTIONS.has(requested) ? requested : 'PENDING';
    const terms = await listUnmappedTerms(orgId, resolution);
    return NextResponse.json({ terms, resolution });
  });
}
