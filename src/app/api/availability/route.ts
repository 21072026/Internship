import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { resolveTimeZone } from '@/lib/timezone';
import { z } from 'zod';
import { findSlotClash, liveSlotsWhere, mayWriteAvailabilityFor, mentorToday, writableMentorId } from '@/lib/availabilityAccess';
import { weekdayOfDate } from '@/lib/availabilitySlots';
import { busyWindows } from '@/lib/busyWindows';
import { mergeWindows } from '@/lib/busyWindowsRule';

// How far ahead the booked hours are read — the portal offers three weeks of slots.
const BUSY_HORIZON_MS = 22 * 24 * 60 * 60_000;

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
//
// @openapi-ignore — this note names TENANT_MODELS and which models fall outside
// the central isolation guarantee. That is a map for anyone hunting tenant leaks
// and must not be republished in the admin API explorer next to x-source; it
// stays here for developers reading the source.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = new URL(request.url).searchParams.get('mentorId');
  // Own hours: unchanged, and deliberately not tenant-gated — your own row is
  // yours whatever org resolution says.
  if (!requested || requested === session.user.id) {
    const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { timezone: true } });
    const today = mentorToday(me?.timezone);
    const [slots, exceptions] = await Promise.all([
      prisma.availabilitySlot.findMany({
        where: liveSlotsWhere(session.user.id, today),
        orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      }),
      prisma.availabilityException.findMany({
        where: { mentorId: session.user.id, endDate: { gte: today } },
        orderBy: { startDate: 'asc' },
      }),
    ]);
    return NextResponse.json({ slots, exceptions, ...zoneOf(me?.timezone) });
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

    const today = mentorToday(mentor.timezone);
    const [slots, away] = await Promise.all([
      prisma.availabilitySlot.findMany({
        where: liveSlotsWhere(mentor.id, today),
        orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      }),
      // The dates only (#2001): that a mentor is away is what a booker needs;
      // why is the mentor's own business.
      prisma.availabilityException.findMany({
        where: { mentorId: mentor.id, endDate: { gte: today } },
        orderBy: { startDate: 'asc' },
        select: { startDate: true, endDate: true },
      }),
    ]);
    // The hours already booked (#1995), so the picker stops offering them. Only
    // to the people who can book them — an admin, or the paired mentee, whose
    // own meetings count too — and only as bare start/end: whose meeting it is
    // and what it is called are none of the reader's business. A directory
    // visitor gets the weekly hours, never the diary.
    let busy: { start: string; end: string }[] | undefined;
    if (session.user.role === 'ADMIN' || session.user.role === 'MENTEE') {
      const now = new Date();
      const people = session.user.role === 'MENTEE' ? [mentor.id, session.user.id] : [mentor.id];
      const windows = await busyWindows(prisma, people, now, new Date(now.getTime() + BUSY_HORIZON_MS));
      busy = mergeWindows(windows).map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() }));
    }
    return NextResponse.json({ slots, exceptions: away, ...zoneOf(mentor.timezone), ...(busy ? { busy } : {}) });
  });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const schema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME),
  endTime: z.string().regex(TIME),
  // A one-off on this date (#2001); `weekday` is then derived from it.
  date: z.string().regex(DATE).nullish(),
  note: z.string().trim().max(120).nullish(),
  // An ADMIN writing for a mentor of their own org; anyone else writes their own.
  mentorId: z.string().min(1).optional(),
});

function clashResponse(clash: { startTime: string; endTime: string; date: Date | null }) {
  return NextResponse.json(
    { error: 'Overlaps an existing slot', code: 'overlap', clash: { ...clash, date: clash.date ? clash.date.toISOString().slice(0, 10) : null } },
    { status: 409 }
  );
}

async function zoneOfMentor(mentorId: string) {
  return (await prisma.user.findUnique({ where: { id: mentorId }, select: { timezone: true } }))?.timezone ?? null;
}

// POST — add a slot to the current mentor's availability (or, for an ADMIN, to
// a mentor of their own organization). Weekly, or a dated one-off.
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
  const mentorId = await writableMentorId(session, parsed.data.mentorId);
  if (!mentorId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const { startTime, endTime } = parsed.data;
  const date = parsed.data.date ? new Date(`${parsed.data.date}T00:00:00Z`) : null;
  // Kept non-null for a one-off too, derived from the date, so every query that
  // reads `weekday` keeps working.
  const weekday = parsed.data.date ? weekdayOfDate(parsed.data.date) : parsed.data.weekday;
  const today = mentorToday(await zoneOfMentor(mentorId));
  if (date && date < today) return NextResponse.json({ error: 'That date has passed' }, { status: 400 });
  // Reject an interval that overlaps one already on offer that day, exact
  // repeats included (#1363) — see findSlotClash for which rows compete.
  const clash = await findSlotClash(mentorId, { weekday, date, startTime, endTime }, { today });
  if (clash) return clashResponse(clash);

  const slot = await prisma.availabilitySlot.create({
    data: { mentorId, weekday, startTime, endTime, date, note: parsed.data.note || null },
  });
  return NextResponse.json({ slot }, { status: 201 });
}

const patchSchema = z
  .object({
    id: z.string().min(1),
    weekday: z.number().int().min(0).max(6).optional(),
    // null turns a one-off back into a weekly slot.
    date: z.string().regex(DATE).nullable().optional(),
    startTime: z.string().regex(TIME).optional(),
    endTime: z.string().regex(TIME).optional(),
    note: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

// PATCH — change a slot in place (#2001): its day, its times, its date, its
// note. Deleting and retyping it was the only way, and a busy volunteer does
// not do that. The overlap rule is the POST's, minus the row being edited — a
// slot does not collide with itself.
export async function PATCH(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const current = await prisma.availabilitySlot.findUnique({ where: { id: parsed.data.id } });
  // Not yours (and not your org's, as an admin) reads exactly like missing.
  if (!current || !(await mayWriteAvailabilityFor(session, current.mentorId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const p = parsed.data;
  const startTime = p.startTime ?? current.startTime;
  const endTime = p.endTime ?? current.endTime;
  if (endTime <= startTime) return NextResponse.json({ error: 'End time must be after start time' }, { status: 400 });
  const date = p.date === undefined ? current.date : p.date ? new Date(`${p.date}T00:00:00Z`) : null;
  const weekday = date ? weekdayOfDate(date.toISOString()) : p.weekday ?? current.weekday;
  const today = mentorToday(await zoneOfMentor(current.mentorId));
  if (date && p.date && date < today) return NextResponse.json({ error: 'That date has passed' }, { status: 400 });
  const clash = await findSlotClash(current.mentorId, { weekday, date, startTime, endTime }, { excludeId: current.id, today });
  if (clash) return clashResponse(clash);
  const slot = await prisma.availabilitySlot.update({
    where: { id: current.id },
    data: { weekday, date, startTime, endTime, ...(p.note !== undefined ? { note: p.note || null } : {}) },
  });
  return NextResponse.json({ slot });
}

// DELETE ?id= — remove one of the current mentor's slots.
//
// @openapi-ignore — same reason as the GET above (#1447): the paragraph below
// describes a cross-tenant delete and the missing hop that allowed it, which is
// a lead for anyone hunting the next instance. Useful to a developer reading the
// source, not something to publish in the admin API explorer.
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
  if (slot.mentorId !== session.user.id && !(await mayWriteAvailabilityFor(session, slot.mentorId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await prisma.availabilitySlot.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
