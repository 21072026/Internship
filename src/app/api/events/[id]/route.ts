import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { isValidTimeZone } from '@/lib/timezone';
import { resolveMeetingLink, meetingLinkRefusal } from '@/lib/meetingRoom';
import { canManageEvent } from '@/lib/groupEventRule';
import { updateEventSchema } from '@/lib/groupEventInput';
import { audienceUserIds, eventSelect, eventView, noticeEvent, setEventCapacity, visibleEventsWhere } from '@/lib/groupEvents';

// One group session (#1856). GET answers 404 for an event the caller may not
// see — the same answer as a missing id, never a 403 that confirms it. The
// participant list comes only with `canManage` (host or an admin of the org).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
      const event = where ? await prisma.programEvent.findFirst({ where: { AND: [where, { id }] }, select: eventSelect }) : null;
      if (!event) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      const manage = canManageEvent(actor, event);
      const [mine, waitlisted] = await Promise.all([
        prisma.eventRegistration.findUnique({
          where: { eventId_userId: { eventId: id, userId: actor.userId } },
          select: { state: true, attendance: true, attendedAt: true },
        }),
        prisma.eventRegistration.count({ where: { eventId: id, state: 'WAITLISTED' } }),
      ]);
      const participants = manage
        ? await prisma.eventRegistration.findMany({
            where: { eventId: id },
            orderBy: [{ state: 'asc' }, { registeredAt: 'asc' }],
            select: {
              userId: true,
              state: true,
              registeredAt: true,
              promotedAt: true,
              cancelledAt: true,
              attendance: true,
              attendedAt: true,
              user: { select: { fullName: true, role: true } },
            },
          })
        : undefined;
      return NextResponse.json({ event: eventView(event, { manage, mine, waitlisted }), participants });
    });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const orgId = resolveOrgId(session);
    const capGate = await requireCapability(orgId, 'mentorship');
    if (capGate) return capGate;
    const actor = { role: session.user.role, userId: session.user.id, orgId };
    const parsed = updateEventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed', details: parsed.error.flatten() }, { status: 400 });
    const input = parsed.data;
    if (input.timeZone && !isValidTimeZone(input.timeZone)) return NextResponse.json({ error: 'Unknown time zone', code: 'invalid_time_zone' }, { status: 400 });
    const { id } = await params;

    return withTenantScope(session, async () => {
      const where = await visibleEventsWhere(actor);
      const event = where ? await prisma.programEvent.findFirst({ where: { AND: [where, { id }] }, select: eventSelect }) : null;
      if (!event || !canManageEvent(actor, event)) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      if (event.cancelledAt) return NextResponse.json({ error: 'The session was cancelled', code: 'event_cancelled' }, { status: 409 });

      const startsAt = input.startsAt ? new Date(input.startsAt) : undefined;
      if (startsAt && startsAt.getTime() <= Date.now()) {
        return NextResponse.json({ error: 'The session must start in the future', code: 'starts_in_past' }, { status: 400 });
      }
      let joinUrl: string | undefined;
      if (input.joinUrl) {
        const link = await resolveMeetingLink({ inviteeCount: event.capacity, orgId, organizerId: event.hostId, pastedLink: input.joinUrl });
        if (!link.ok) return meetingLinkRefusal(link);
        joinUrl = link.link;
      }
      // The cap first: it is the only field with a refusal of its own, and it
      // runs under the event's row lock with the waitlist fill.
      if (input.capacity !== undefined && input.capacity !== event.capacity) {
        const cap = await setEventCapacity(id, input.capacity);
        if (!cap.ok) return NextResponse.json({ error: 'Fewer seats than people already registered', code: cap.code }, { status: 409 });
      }
      const publishing = input.publish === true && !event.publishedAt;
      const updated = await prisma.programEvent.update({
        where: { id },
        data: {
          title: input.title,
          description: input.description === undefined ? undefined : input.description || null,
          startsAt,
          timeZone: input.timeZone,
          durationMinutes: input.durationMinutes,
          location: input.location === undefined ? undefined : input.location || null,
          joinUrl,
          publishedAt: publishing ? new Date() : undefined,
        },
        select: eventSelect,
      });
      await logActivity({ action: publishing ? 'event.published' : 'event.updated', actorId: actor.userId, targetType: 'ProgramEvent', targetId: id, orgId });
      if (publishing) {
        await noticeEvent(id, await audienceUserIds(updated), 'event.published');
      } else if (event.publishedAt && startsAt && startsAt.getTime() !== event.startsAt.getTime()) {
        const people = await prisma.eventRegistration.findMany({
          where: { eventId: id, state: { in: ['REGISTERED', 'WAITLISTED'] } },
          select: { userId: true },
        });
        await noticeEvent(id, people.map((p) => p.userId), 'event.updated');
      }
      const waitlisted = await prisma.eventRegistration.count({ where: { eventId: id, state: 'WAITLISTED' } });
      return NextResponse.json({ event: eventView(updated, { manage: true, mine: null, waitlisted }) });
    });
  });
}
