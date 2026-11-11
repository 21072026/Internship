import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { isValidTimeZone } from '@/lib/timezone';
import { resolveMeetingLink, meetingLinkRefusal } from '@/lib/meetingRoom';
import { canCreateEvent, canManageEvent } from '@/lib/groupEventRule';
import { createEventSchema } from '@/lib/groupEventInput';
import { audienceUserIds, eventSelect, eventView, noticeEvent, programIdsOf, visibleEventsWhere } from '@/lib/groupEvents';

// Group sessions and office hours (#1856).
// GET  — the events this person may see; `?when=past` for the ones that ended.
// POST — an ADMIN or MENTOR publishes (or drafts) one.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const orgId = resolveOrgId(session);
    const capGate = await requireCapability(orgId, 'mentorship');
    if (capGate) return capGate;
    const actor = { role: session.user.role, userId: session.user.id, orgId };
    const past = new URL(request.url).searchParams.get('when') === 'past';

    return withTenantScope(session, async () => {
      const where = await visibleEventsWhere(actor);
      if (!where) return NextResponse.json({ events: [] });
      const now = new Date();
      const rows = await prisma.programEvent.findMany({
        where: { AND: [where, past ? { startsAt: { lt: now } } : { startsAt: { gte: new Date(now.getTime() - 24 * 3600_000) } }] },
        select: eventSelect,
        orderBy: { startsAt: past ? 'desc' : 'asc' },
        take: 100,
      });
      const ids = rows.map((r) => r.id);
      const [mine, waitlists] = await Promise.all([
        prisma.eventRegistration.findMany({
          where: { eventId: { in: ids }, userId: actor.userId },
          select: { eventId: true, state: true, attendance: true, attendedAt: true },
        }),
        prisma.eventRegistration.groupBy({ by: ['eventId'], where: { eventId: { in: ids }, state: 'WAITLISTED' }, _count: { _all: true } }),
      ]);
      const mineBy = new Map(mine.map((m) => [m.eventId, { state: m.state, attendance: m.attendance, attendedAt: m.attendedAt }]));
      const waitBy = new Map(waitlists.map((w) => [w.eventId, w._count._all]));
      return NextResponse.json({
        events: rows.map((e) =>
          eventView(e, { manage: canManageEvent(actor, e), mine: mineBy.get(e.id) ?? null, waitlisted: waitBy.get(e.id) ?? 0 }),
        ),
      });
    });
  });
}

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = session.user.role;
    if (!canCreateEvent(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const capGate = await requireCapability(orgId, 'mentorship');
    if (capGate) return capGate;
    const parsed = createEventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed', details: parsed.error.flatten() }, { status: 400 });
    const input = parsed.data;
    if (!isValidTimeZone(input.timeZone)) return NextResponse.json({ error: 'Unknown time zone', code: 'invalid_time_zone' }, { status: 400 });
    const startsAt = new Date(input.startsAt);
    if (startsAt.getTime() <= Date.now()) return NextResponse.json({ error: 'The session must start in the future', code: 'starts_in_past' }, { status: 400 });

    return withTenantScope(session, async () => {
      // Host: a mentor always hosts their own session; an admin may name a
      // mentor or admin of the org (read through the scoped client).
      let hostId = session.user.id;
      // "Admin" is the permission layer's answer (#1571), asked only when a host is named.
      if (
        input.hostId &&
        input.hostId !== session.user.id &&
        (await (async () => {
          const actor = await actorFromSession(session);
          return !!actor && (await can(actor, 'program.write', undefined, session));
        })())
      ) {
        const host = await prisma.user.findFirst({ where: { id: input.hostId, orgId, role: { in: ['ADMIN', 'MENTOR'] }, isActive: true }, select: { id: true } });
        if (!host) return NextResponse.json({ error: 'Unknown host', code: 'invalid_host' }, { status: 400 });
        hostId = host.id;
      }
      if (input.programId) {
        const program = await prisma.cohort.findFirst({ where: { id: input.programId, orgId }, select: { id: true } });
        if (!program) return NextResponse.json({ error: 'Unknown programme', code: 'invalid_program' }, { status: 400 });
        // A mentor publishes only to a programme they are in.
        if (role === 'MENTOR' && !(await programIdsOf(session.user.id)).includes(program.id)) {
          return NextResponse.json({ error: 'Not your programme', code: 'invalid_program' }, { status: 403 });
        }
      }
      // An in-person session with no link stays link-less; otherwise the one
      // resolver picks the room (pasted → personal → ours), refusing a link we
      // would not send people to. `inviteeCount` is the cap, so JaaS (1:1
      // only) is never chosen for a group.
      let joinUrl: string | null = null;
      if (input.joinUrl || !input.location) {
        const link = await resolveMeetingLink({ inviteeCount: input.capacity ?? null, orgId, organizerId: hostId, pastedLink: input.joinUrl ?? null });
        if (!link.ok) return meetingLinkRefusal(link);
        joinUrl = link.link;
      }
      const event = await prisma.programEvent.create({
        data: {
          orgId,
          programId: input.programId ?? null,
          title: input.title,
          description: input.description || null,
          startsAt,
          timeZone: input.timeZone,
          durationMinutes: input.durationMinutes,
          capacity: input.capacity ?? null,
          location: input.location || null,
          joinUrl,
          hostId,
          audience: input.audience,
          createdById: session.user.id,
          publishedAt: input.publish ? new Date() : null,
        },
        select: eventSelect,
      });
      await logActivity({ action: 'event.created', actorId: session.user.id, targetType: 'ProgramEvent', targetId: event.id, detail: input.publish ? 'published' : 'draft', orgId });
      if (event.publishedAt) await noticeEvent(event.id, await audienceUserIds(event), 'event.published');
      return NextResponse.json({ event: eventView(event, { manage: true, mine: null, waitlisted: 0 }) }, { status: 201 });
    });
  });
}
