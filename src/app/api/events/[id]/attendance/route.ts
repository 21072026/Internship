import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { attendanceOpen, canManageEvent } from '@/lib/groupEventRule';
import { attendanceSchema } from '@/lib/groupEventInput';
import { visibleEventsWhere } from '@/lib/groupEvents';

// PATCH — the host (or an admin) records who turned up (#1856), one person at a
// time, in #2014's vocabulary. Lives on the EventRegistration row; `null`
// clears a mistaken mark. The registrant reads it back on their own event card.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const orgId = resolveOrgId(session);
    const capGate = await requireCapability(orgId, 'mentorship');
    if (capGate) return capGate;
    const actor = { role: session.user.role, userId: session.user.id, orgId };
    const parsed = attendanceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed', details: parsed.error.flatten() }, { status: 400 });
    const { userId, attendance } = parsed.data;
    const { id } = await params;

    return withTenantScope(session, async () => {
      const where = await visibleEventsWhere(actor);
      const event = where
        ? await prisma.programEvent.findFirst({
            where: { AND: [where, { id }] },
            select: { id: true, hostId: true, orgId: true, startsAt: true, durationMinutes: true, publishedAt: true, cancelledAt: true },
          })
        : null;
      if (!event || !canManageEvent(actor, event)) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      if (!attendanceOpen(event, new Date())) return NextResponse.json({ error: 'Attendance opens when the session starts', code: 'attendance_not_open' }, { status: 409 });
      const now = new Date();
      const done = await prisma.eventRegistration.updateMany({
        where: { eventId: id, userId },
        data: {
          attendance,
          attendedAt: attendance === 'ATTENDED' ? now : null,
          attendanceRecordedById: attendance ? actor.userId : null,
        },
      });
      if (done.count !== 1) return NextResponse.json({ error: 'Not registered', code: 'not_registered' }, { status: 404 });
      return NextResponse.json({ userId, attendance });
    });
  });
}
