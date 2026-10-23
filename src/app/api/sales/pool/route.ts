import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { listLeadPool } from '@/lib/leadClaim';

// The unassigned lead pool of the caller's organization (src/lib/leadClaim.ts):
// leads a machine brought in that nobody has taken yet. Read by every sales rep
// of the org; the org is the session's.

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;
    return withTenantScope(session, async () => NextResponse.json(await listLeadPool(g.orgId)));
  });
}
