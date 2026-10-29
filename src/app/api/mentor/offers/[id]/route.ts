import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { withdrawMentorOffer } from '@/lib/mentorOffers';

// DELETE /api/mentor/offers/[id] — the mentor withdraws their own pending
// offer (#1809). Someone else's offer, or one no longer pending, is 404.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const denied = await requireCapability(resolveOrgId(session), 'mentorship');
  if (denied) return denied;
  const { id } = await params;
  return withTenantScope(session, async () =>
    (await withdrawMentorOffer({ session, offerId: id, request }))
      ? NextResponse.json({ ok: true, status: 'WITHDRAWN' })
      : NextResponse.json({ error: 'Not found' }, { status: 404 })
  );
}
