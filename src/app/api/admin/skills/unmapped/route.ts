import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { listUnmappedTerms } from '@/lib/skillQueue';

// The skill backfill's review queue (#1819): free-text terms nothing in the
// org's vocabulary resolved, most frequent first. ADMIN only, checked here;
// the org comes from the session, never from the request.
const RESOLUTIONS = new Set(['PENDING', 'PROMOTED', 'ALIASED', 'DISCARDED']);

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ terms: [] });
    const requested = new URL(request.url).searchParams.get('resolution') ?? 'PENDING';
    const resolution = RESOLUTIONS.has(requested) ? requested : 'PENDING';
    const terms = await listUnmappedTerms(orgId, resolution);
    return NextResponse.json({ terms, resolution });
  });
}
