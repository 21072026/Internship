import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { listSalesTeam } from '@/lib/leadHandoff';

// The rep strip above the sales and admin boards: who a lead can be handed to
// (src/lib/leadHandoff.ts). MARKETING only, the caller's own org only — the
// same door as the lead pool. Names and avatars, nothing else.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;
    return withTenantScope(session, async () => {
      const members = await listSalesTeam(g.orgId, g.userId);
      return NextResponse.json({ members });
    });
  });
}
