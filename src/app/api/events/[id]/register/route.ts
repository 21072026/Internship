import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { cancelRegistration, inAudience, registerForEvent, visibleEventsWhere } from '@/lib/groupEvents';

// POST   — take a place at a group session (#1856); past the cap, a waitlist spot.
// DELETE — give it up; a freed seat goes to the first person waiting.
// The session is the credential: there is no token, and nobody registers
// anybody else. Free core — never plan-gated.
async function openEvent() {
  const session = await getServerSession(authOptions);
  if (!session) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  const orgId = resolveOrgId(session);
  const capGate = await requireCapability(orgId, 'mentorship');
  if (capGate) return { response: capGate } as const;
  return { session, orgId } as const;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const opened = await openEvent();
    if ('response' in opened) return opened.response;
    const { session, orgId } = opened;
    const actor = { role: session.user.role, userId: session.user.id, orgId };

    return withTenantScope(session, async () => {
      const where = await visibleEventsWhere(actor);
      const event = where
        ? await prisma.programEvent.findFirst({ where: { AND: [where, { id }] }, select: { id: true, audience: true, programId: true, hostId: true } })
        : null;
      if (!event) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      if (event.hostId === actor.userId) return NextResponse.json({ error: 'You host this session', code: 'host_cannot_register' }, { status: 409 });
      // Visible is not enough: a registration held from before someone left the
      // programme keeps the event visible, but a new one needs the audience.
      if (!(await inAudience(event, { id: actor.userId, role: actor.role }))) {
        return NextResponse.json({ error: 'This session is not open to you', code: 'not_in_audience' }, { status: 403 });
      }
      const outcome = await registerForEvent(id, actor.userId);
      if (!outcome.ok) {
        const status = outcome.code === 'not_found' ? 404 : 409;
        return NextResponse.json({ error: 'Registration is closed', code: outcome.code }, { status });
      }
      return NextResponse.json({ state: outcome.state, alreadyRegistered: outcome.alreadyRegistered }, { status: outcome.alreadyRegistered ? 200 : 201 });
    });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const opened = await openEvent();
    if ('response' in opened) return opened.response;
    const { session, orgId } = opened;
    const actor = { role: session.user.role, userId: session.user.id, orgId };

    return withTenantScope(session, async () => {
      const where = await visibleEventsWhere(actor);
      const event = where ? await prisma.programEvent.findFirst({ where: { AND: [where, { id }] }, select: { id: true } }) : null;
      if (!event) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      const outcome = await cancelRegistration(id, actor.userId);
      if (!outcome.ok) {
        return NextResponse.json({ error: 'Nothing to cancel', code: outcome.code }, { status: outcome.code === 'not_registered' ? 404 : 409 });
      }
      return NextResponse.json({ state: 'CANCELLED', promoted: outcome.promoted.length });
    });
  });
}
