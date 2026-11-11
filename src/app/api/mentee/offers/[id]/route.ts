import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { answerMentorOffer } from '@/lib/mentorOffers';

// POST /api/mentee/offers/[id] { action: 'accept' | 'decline' } — the mentee
// answers a Mentor Offer (#1809). Accept creates the pairing through the shared
// decision service; decline asks for no reason. Not theirs → 404.
const schema = z.object({ action: z.enum(['accept', 'decline']) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const denied = await requireCapability(resolveOrgId(session), 'mentorship');
  if (denied) return denied;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const result = await answerMentorOffer({ session, offerId: id, action: parsed.data.action, request });
    return NextResponse.json(result.body, { status: result.status });
  });
}
