import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { claimLead } from '@/lib/leadClaim';

// "Take it": one unassigned lead onto the caller's own book, at the org's first
// stage (src/lib/leadClaim.ts). Never onto somebody else's — the body is not
// read at all. 404 for a lead that is not in this org's pool (another org's id
// included, never a 403 that would confirm it); 409 `taken` when a colleague
// was faster or an admin assigned it.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;
    const { id } = await params;
    return withTenantScope(session, async () => {
      const outcome = await claimLead({ orgId: g.orgId, leadId: id, ownerId: g.userId });
      if (!outcome.ok) {
        return outcome.code === 'taken'
          ? NextResponse.json({ code: 'taken', error: 'Somebody already took this lead' }, { status: 409 })
          : NextResponse.json({ code: 'missing', error: 'Not found' }, { status: 404 });
      }
      await logActivity({
        action: 'lead.claimed',
        orgId: g.orgId,
        actorId: g.userId,
        targetType: 'MentorshipRelation',
        targetId: outcome.relationId,
        detail: `stage=${outcome.stage}`,
        request,
      });
      return NextResponse.json({ relationId: outcome.relationId, stage: outcome.stage }, { status: 201 });
    });
  });
}
