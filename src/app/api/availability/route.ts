import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { resolveTimeZone } from '@/lib/timezone';
import { z } from 'zod';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// A slot stores a wall-clock time with no zone of its own (#1363). It is read in
// the MENTOR'S `User.timezone`, and every response says which zone that is, so
// no reader has to guess — the screen prints it and #1361's date expansion will
// resolve against it.
//
// Decision (recorded on #1363): interpret in `User.timezone` rather than adding
// a `timezone` column to AvailabilitySlot.
//   - DST is handled identically either way. Both store a wall clock plus a zone
//     NAME, so "Monday 09:00" stays 09:00 across a transition, which is what a
//     person means by a weekly slot. A per-slot fixed offset would be the only
//     wrong option, and neither design uses one.
//   - The scenario a per-slot column would buy — hours entered while travelling
//     — is one this product does not have, and it makes the common case worse:
//     a mentor who actually relocates wants ALL their hours to move, which one
//     profile field does in a single edit and a per-row column turns into
//     editing every row.
// `set` is false when the mentor never chose one, so the screen can prompt
// instead of silently applying the fallback zone.
function zoneOf(timezone: string | null | undefined) {
  return { timezone: resolveTimeZone(timezone), timezoneSet: !!timezone };
}

// GET — availability slots. Without a parameter you get your own; ?mentorId=
// returns a mentor's slots (for booking).
//
// "Your own" deliberately includes ADMINs: POST lets an admin add slots (they
// reach the mentor shell through the view switch to work their own mentees), so
// a GET that only defaulted for MENTORs left the page permanently empty — every
// added slot vanished and the Add button looked dead.
//
// ?mentorId= used to return ANY mentor's hours to ANY signed-in account, across
// organizations (#1350). AvailabilitySlot carries no orgId and is not one of
// orgContext's TENANT_MODELS, so the central isolation middleware never saw
// this query — the row is reached through `mentorId → User`, and nothing made
// that hop. The gate below is that hop, made explicit.
//
// Who may read another mentor's hours is deliberately the same set that may see
// the mentor at all, so availability can never expose someone the directory
// would not: an ADMIN in the org, a mentee with an ACTIVE relation to them, or a
// mentor who opted into the directory (publicProfile + an active
// MENTOR_DIRECTORY_VISIBILITY consent — the double opt-in from #937/#938).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = new URL(request.url).searchParams.get('mentorId');
  // Own hours: unchanged, and deliberately not tenant-gated — your own row is
  // yours whatever org resolution says.
  if (!requested || requested === session.user.id) {
    const [me, slots] = await Promise.all([
      prisma.user.findUnique({ where: { id: session.user.id }, select: { timezone: true } }),
      prisma.availabilitySlot.findMany({
        where: { mentorId: session.user.id },
        orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      }),
    ]);
    return NextResponse.json({ slots, ...zoneOf(me?.timezone) });
  }

  // Same fail-closed role gate as the mentor directory (#831): COMPANY and
  // SOURCE have their own separately-consented surfaces and no business reading
  // a mentor's calendar.
  if (!['MENTEE', 'MENTOR', 'ADMIN'].includes(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    const mentor = await prisma.user.findFirst({
      where: { id: requested, role: 'MENTOR', isActive: true, orgId },
      select: { id: true, publicProfile: true, timezone: true },
    });
    // 404 rather than 403 on purpose: a 403 would confirm that this id exists
    // to a caller in another organization.
    if (!mentor) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let visible = session.user.role === 'ADMIN';
    // A mentee may read the hours of the mentor they are actually paired with.
    // Deliberately MENTEE-only: there is no co-mentoring feature, so a mentor
    // has no errand in a peer's calendar — and a relation filter without
    // `menteeId` would match "this mentor has some mentee", which is true for
    // nearly everyone and would be a gate that gates nothing.
    if (!visible && session.user.role === 'MENTEE') {
      const related = await prisma.mentorshipRelation.findFirst({
        where: { status: 'ACTIVE', mentorId: mentor.id, menteeId: session.user.id },
        select: { id: true },
      });
      visible = !!related;
    }
    if (!visible && mentor.publicProfile) {
      const consent = await prisma.userConsent.findFirst({
        where: {
          userId: mentor.id,
          type: 'MENTOR_DIRECTORY_VISIBILITY',
          grantedAt: { not: null },
          revokedAt: null,
        },
        select: { id: true },
      });
      visible = !!consent;
    }
    if (!visible) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const slots = await prisma.availabilitySlot.findMany({
      where: { mentorId: mentor.id },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
    return NextResponse.json({ slots, ...zoneOf(mentor.timezone) });
  });
}

const schema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME),
  endTime: z.string().regex(TIME),
});

// POST — add a slot to the current mentor's availability.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  if (parsed.data.endTime <= parsed.data.startTime) {
    return NextResponse.json({ error: 'End time must be after start time' }, { status: 400 });
  }
  // Reject an interval that overlaps one already on that weekday, exact repeats
  // included (#1363). Two intervals overlap iff each starts before the other
  // ends — the half-open comparison, so 09:00–10:00 and 10:00–11:00 are
  // back-to-back rather than overlapping, which is how a person reads them.
  // Times are zero-padded "HH:MM", so string order is chronological order and
  // the DB can do the comparison.
  const { weekday, startTime, endTime } = parsed.data;
  const clash = await prisma.availabilitySlot.findFirst({
    where: {
      mentorId: session.user.id,
      weekday,
      startTime: { lt: endTime },
      endTime: { gt: startTime },
    },
    select: { startTime: true, endTime: true },
  });
  if (clash) {
    return NextResponse.json(
      { error: 'Overlaps an existing slot', code: 'overlap', clash },
      { status: 409 }
    );
  }

  const slot = await prisma.availabilitySlot.create({ data: { mentorId: session.user.id, ...parsed.data } });
  return NextResponse.json({ slot }, { status: 201 });
}

// DELETE ?id= — remove one of the current mentor's slots.
//
// The admin escape hatch is scoped to the admin's OWN organization (#1350): the
// previous `role !== 'ADMIN'` test was global, so an admin who knew a cuid could
// delete a slot belonging to a mentor in a different tenant. Same missing
// `mentorId → User` hop as the GET above.
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = new URL(request.url).searchParams.get('id') || '';
  const slot = await prisma.availabilitySlot.findUnique({ where: { id } });
  if (!slot) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (slot.mentorId !== session.user.id) {
    if (session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const sameOrg = await withTenantScope(session, () =>
      prisma.user.findFirst({
        where: { id: slot.mentorId, orgId: resolveOrgId(session) },
        select: { id: true },
      })
    );
    if (!sameOrg) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await prisma.availabilitySlot.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
