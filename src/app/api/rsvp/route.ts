import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';

// Public endpoint — an invitee responds to a meeting invite via the token in
// their email. No auth: the unguessable token is the credential.
//
// Two kinds of token land here (#1430) and they are looked up separately, never
// as one query over a shared column:
//   Meeting.rsvpToken      — a participant (mentor/mentee/project member)
//   MeetingGuest.rsvpToken — an outsider with no account here
// Both answer with exactly the same public projection of the meeting, so the
// /rsvp page needs no branch and a guest learns nothing a participant wouldn't.

type Resolved =
  | { kind: 'meeting'; meetingId: string; guestId: null }
  | { kind: 'guest'; meetingId: string; guestId: string };

// Meeting first — it is the older and far more common credential — then guest.
// A token that matched neither is simply Not found; the two are never
// distinguished in a response, so this cannot be used to tell a revoked guest
// invitation from a wrong token.
async function resolveToken(token: string): Promise<Resolved | null> {
  if (!token) return null;
  const meeting = await prisma.meeting.findUnique({ where: { rsvpToken: token }, select: { id: true } });
  if (meeting) return { kind: 'meeting', meetingId: meeting.id, guestId: null };
  const guest = await prisma.meetingGuest.findUnique({
    where: { rsvpToken: token },
    select: { id: true, meetingId: true },
  });
  if (guest) return { kind: 'guest', meetingId: guest.meetingId, guestId: guest.id };
  return null;
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') || '';
  const resolved = await resolveToken(token);
  if (!resolved) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const meeting = await prisma.meeting.findUnique({
    where: { id: resolved.meetingId },
    select: { title: true, scheduledAt: true, meetLink: true, rsvp: true },
  });
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // A guest's own answer, not the host row's — the host row's `rsvp` belongs to
  // the participant that meeting row was written for, and showing it to a guest
  // would both mislead them and leak someone else's answer.
  if (resolved.kind === 'guest') {
    const guest = await prisma.meetingGuest.findUnique({
      where: { id: resolved.guestId },
      select: { rsvp: true, name: true },
    });
    return NextResponse.json({
      meeting: { ...meeting, rsvp: guest?.rsvp ?? 'PENDING' },
      guest: { name: guest?.name ?? null },
    });
  }
  return NextResponse.json({ meeting });
}

const schema = z.object({ token: z.string().min(1), response: z.enum(['yes', 'no']) });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'rsvp', { limit: 20, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { token, response } = parsed.data;
  const status = response === 'yes' ? 'ACCEPTED' : 'DECLINED';

  const resolved = await resolveToken(token);
  if (!resolved) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const meeting = await prisma.meeting.findUnique({
    where: { id: resolved.meetingId },
    include: { relation: { select: { mentorId: true, menteeId: true } } },
  });
  if (!meeting) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const creatorLink = meeting.projectId
    ? `/projects/${meeting.projectId}`
    : meeting.conversationId
      ? `/messages/c/${meeting.conversationId}`
      : meeting.relation?.menteeId === meeting.createdById
        ? '/portal'
        : '/mentor/meetings';

  if (resolved.kind === 'guest') {
    const guest = await prisma.meetingGuest.update({
      where: { id: resolved.guestId },
      data: { rsvp: status, respondedAt: new Date() },
      select: { email: true, name: true, invitedById: true },
    });
    // The person who typed the address is the one waiting on the answer, and
    // they are not necessarily whoever created the meeting row (an admin can
    // schedule on a mentor's relation). Notify them by name: "an invitee" is
    // useless when the invitee is an outsider the organizer chose one by one.
    await notify(
      guest.invitedById,
      status === 'ACCEPTED' ? 'guestRsvp.accepted' : 'guestRsvp.declined',
      { title: meeting.title, guest: guest.name || guest.email },
      creatorLink
    );
    return NextResponse.json({ ok: true, rsvp: status });
  }

  await prisma.meeting.update({ where: { id: meeting.id }, data: { rsvp: status } });
  await notify(
    meeting.createdById,
    status === 'ACCEPTED' ? 'rsvp.accepted' : 'rsvp.declined',
    { title: meeting.title },
    creatorLink
  );
  return NextResponse.json({ ok: true, rsvp: status });
}
