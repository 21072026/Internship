import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getThreadIfAllowed } from '@/lib/messaging';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { createMeetingRequest } from '@/lib/meetingRequestCreate';

// GET ?relationId= — meeting requests for a thread (participants/admin).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const relationId = new URL(request.url).searchParams.get('relationId') || '';
    // getThreadIfAllowed lets any ADMIN through; another tenant's relation
    // answers exactly like a missing one (#2542).
    const rel = await getThreadIfAllowed(session.user, relationId);
    if (!rel || !(await inCallerTenant(rel.orgId, resolveOrgId(session)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // A counter-proposal (#1982) carries the meeting it counters, so the panel
    // can say "instead of <old time>" and accept it as a move.
    const requests = await prisma.meetingRequest.findMany({
      where: { relationId },
      orderBy: { createdAt: 'desc' },
      include: { counterOfMeeting: { select: { id: true, title: true, scheduledAt: true, status: true } } },
    });
    return NextResponse.json({ requests });
  });
}

// POST — a participant (typically the mentee) requests a meeting. The body is
// src/lib/meetingRequestCreate.ts, shared with the chat booking flow (#1951).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return createMeetingRequest(session, await request.json().catch(() => null));
}
