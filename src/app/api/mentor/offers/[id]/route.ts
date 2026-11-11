import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { withdrawMentorOffer } from '@/lib/mentorOffers';

// DELETE /api/mentor/offers/[id] — the mentor withdraws their own pending
// offer (#1809). Someone else's offer, or one no longer pending, is 404.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'program.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const denied = await requireCapability(resolveOrgId(session), 'mentorship');
  if (denied) return denied;
  const { id } = await params;
  return withTenantScope(session, async () =>
    (await withdrawMentorOffer({ session, offerId: id, request }))
      ? NextResponse.json({ ok: true, status: 'WITHDRAWN' })
      : NextResponse.json({ error: 'Not found' }, { status: 404 })
  );
}
