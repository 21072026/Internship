import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { decideMeetingRequest } from '@/lib/meetingRequestDecision';
import { requireCapability } from '@/lib/capabilityGate';

// PATCH — the mentor (or admin) accepts or declines a meeting request.
// Accepting creates a confirmed Meeting (with an auto video link) and notifies
// the requester. The body is src/lib/meetingRequestDecision.ts, shared with
// the chat card's Accept/Decline (#1951).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Meeting requests inside a mentorship (MKT-6a).
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;
  return decideMeetingRequest(session, id, await request.json().catch(() => null));
}
