import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { canManageEvent } from '@/lib/groupEventRule';
import { cancelEvent, visibleEventsWhere } from '@/lib/groupEvents';

// POST — the host or an admin calls a group session off (#1856). The row and
// its registrations stay; everyone holding a place or a waitlist spot is told.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const orgId = resolveOrgId(session);
    const capGate = await requireCapability(orgId, 'mentorship');
    if (capGate) return capGate;
    const actor = { role: session.user.role, userId: session.user.id, orgId };
    const { id } = await params;

    return withTenantScope(session, async () => {
      const where = await visibleEventsWhere(actor);
      const event = where ? await prisma.programEvent.findFirst({ where: { AND: [where, { id }] }, select: { id: true, hostId: true, orgId: true } }) : null;
      if (!event || !canManageEvent(actor, event)) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      const done = await cancelEvent(id, actor.userId);
      if (!done) return NextResponse.json({ error: 'Already cancelled', code: 'event_cancelled' }, { status: 409 });
      await logActivity({ action: 'event.cancelled', actorId: actor.userId, targetType: 'ProgramEvent', targetId: id, orgId });
      return NextResponse.json({ ok: true });
    });
  });
}
