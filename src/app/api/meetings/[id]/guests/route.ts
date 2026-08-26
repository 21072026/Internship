import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { loadAccessibleMeeting } from '@/lib/meetingAccess';
import {
  MAX_GUESTS_PER_MEETING,
  guestSchema,
  inviteGuests,
  normalizeGuests,
} from '@/lib/meetingGuests';

// External guests on an existing meeting (#1430).
//
// Scheduling with guests is POST /api/meetings; this is the after-the-fact
// half — "I forgot to invite the client" and "I typed the address wrong" — and
// without it the feature is one-shot: a mistyped address would keep a live
// token forever with no way to take it back.
//
// Who may do it: anyone who may take part in the meeting AND is a mentor,
// admin, or the organizer. A mentee is deliberately excluded even on their own
// meeting — a guest row is an unauthenticated way into the room and an outbound
// email to an arbitrary address, which is not a capability to hand to every
// account in the system.
async function authorize(meetingId: string, user: { id: string; role: string }) {
  const accessible = await loadAccessibleMeeting(user, meetingId);
  if (!accessible) return null;
  const mayInvite = accessible.organizer || user.role === 'MENTOR' || user.role === 'ADMIN';
  return mayInvite ? accessible : null;
}

// GET — the guest list with each one's answer, for the organizer's view.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  return await withTenantScope(session, async () => {
    // Not-yours and does-not-exist answer alike, so the id space stays opaque.
    if (!(await authorize(id, session.user))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const guests = await prisma.meetingGuest.findMany({
      where: { meetingId: id },
      // Never the token: this list is read in a browser and a leaked token is
      // a working credential for the meeting.
      select: { id: true, email: true, name: true, rsvp: true, respondedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return NextResponse.json({ guests });
  });
}

const postSchema = z.object({ guests: z.array(guestSchema).min(1).max(MAX_GUESTS_PER_MEETING) });

// POST — invite one or more outsiders to a meeting that already exists.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Each call fans out mail to addresses the caller chose, so it gets a cap of
  // its own on top of the per-meeting one.
  const limited = enforceRateLimit(request, 'meeting-guests', { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const { id } = await params;

  return await withTenantScope(session, async () => {
    if (!(await authorize(id, session.user))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        meetLink: true,
        timeZone: true,
        relation: { select: { mentor: { select: { email: true } }, mentee: { select: { email: true } } } },
      },
    });
    if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const memberEmails = [meeting.relation?.mentor.email, meeting.relation?.mentee.email].filter(
      (e): e is string => Boolean(e)
    );
    const { guests, rejectedAsMembers } = await normalizeGuests(parsed.data.guests, memberEmails);

    // The cap is per meeting, not per request — otherwise ten requests of two
    // guests each would walk straight past it.
    const existing = await prisma.meetingGuest.count({ where: { meetingId: id } });
    if (existing + guests.length > MAX_GUESTS_PER_MEETING) {
      return NextResponse.json(
        { error: 'Too many guests', max: MAX_GUESTS_PER_MEETING, existing },
        { status: 409 }
      );
    }

    const invited = await inviteGuests({
      meetingId: id,
      guests,
      invitedById: session.user.id,
      title: meeting.title,
      scheduledAt: meeting.scheduledAt,
      meetLink: meeting.meetLink,
      organizerTimeZone: meeting.timeZone,
      organizerName: session.user.name ?? null,
    });

    return NextResponse.json({ invited: invited.length, guests: invited, rejectedAsMembers }, { status: 201 });
  });
}

const deleteSchema = z.object({ guestId: z.string().min(1) });

// DELETE — withdraw an invitation. The row goes, and with it the token: a
// mistyped address must stop being a way into the meeting, not merely stop
// appearing in the list.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  return await withTenantScope(session, async () => {
    if (!(await authorize(id, session.user))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    // Scoped by meetingId as well as id, so a guest id from another meeting
    // cannot be deleted through a meeting the caller does happen to reach.
    const removed = await prisma.meetingGuest.deleteMany({
      where: { id: parsed.data.guestId, meetingId: id },
    });
    if (removed.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
