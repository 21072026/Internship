import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { relationCadence } from '@/lib/meetingCadence';
import { loadPairMeetings } from '@/lib/meetingCadenceData';

// One pair's meeting cadence (#2014): the promised interval, when they last
// actually met, and whether that is inside it. The same deterministic rule as
// the programme figure (src/lib/meetingCadence.ts). The relation's mentor and
// an admin of its tenant may read it — they are the two who can change the
// promise (PUT /api/mentorship/[id] { expectedMeetingIntervalWeeks }).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const relation = await prisma.mentorshipRelation.findFirst({
      where: withinTenant({ id }, await tenantWhere(session)),
      select: { id: true, mentorId: true, expectedMeetingIntervalWeeks: true },
    });
    if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (session.user.role !== 'ADMIN' && relation.mentorId !== session.user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const now = new Date();
    const cadence = relationCadence(relation.expectedMeetingIntervalWeeks, await loadPairMeetings([relation.id], now), now);
    return NextResponse.json({ cadence: { expectedIntervalWeeks: relation.expectedMeetingIntervalWeeks, ...cadence } });
  });
}
