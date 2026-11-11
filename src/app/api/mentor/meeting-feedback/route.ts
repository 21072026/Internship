import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { mentorMeetingQuality } from '@/lib/meetingFeedback';
import { effectiveMinResponses } from '@/lib/surveyPrivacy';

// How a mentor's meetings were rated (#1896) — the AGGREGATE only, and only
// above the response floor: `{ n, avgHelpfulness, happenedRate }` or `null`.
// No individual rating, rater or note is ever part of this response. A
// MENTOR reads their own; an ADMIN may read any mentor of their tenant with
// ?mentorId=.

const WINDOW_DAYS = 90;

export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  return withTenantScope(session, async () => {
    let mentorId = session.user.id;
    if (admin) {
      const asked = new URL(request.url).searchParams.get('mentorId');
      if (!asked) return NextResponse.json({ error: 'mentorId required' }, { status: 400 });
      const mentor = await prisma.user.findFirst({ where: withinTenant({ id: asked, role: 'MENTOR' as const }, await tenantWhere(session)), select: { id: true } });
      if (!mentor) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      mentorId = mentor.id;
    }
    return NextResponse.json({ windowDays: WINDOW_DAYS, minResponses: effectiveMinResponses(), quality: await mentorMeetingQuality(mentorId, WINDOW_DAYS) });
  });
}
