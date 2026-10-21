import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { formatInTimeZone, isValidTimeZone, parseUserDateTime } from '@/lib/timezone';
import { intlLocaleFor } from '@/lib/interviewRequests';

// Public endpoint — an invitee responds to a meeting invite via the token in
// their email. No auth: the unguessable token is the credential.
//
// Two kinds of token land here (#1446) and they are looked up separately, never
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
  // Reads were unlimited, which since #1446 makes this the probe surface for
  // *two* token spaces — and it answers with the join link. Generous enough
  // that a real invitee reloading the page never notices.
  const limited = enforceRateLimit(request, 'rsvp-read', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const token = new URL(request.url).searchParams.get('token') || '';
  const resolved = await resolveToken(token);
  if (!resolved) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const row = await prisma.meeting.findUnique({
    where: { id: resolved.meetingId },
    select: { title: true, scheduledAt: true, meetLink: true, rsvp: true, relationId: true, status: true, endedAt: true },
  });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { relationId, status, endedAt, ...meeting } = row;

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
      // A guest has no relation to file a counter-proposal in (#1982).
      canCounter: false,
    });
  }
  // Whether "suggest another time" is offered (#1982): only a participant of a
  // relation meeting that is still on — see counterable() in POST.
  return NextResponse.json({ meeting, canCounter: !!relationId && status === 'SCHEDULED' && !endedAt && !!meeting.scheduledAt });
}

const schema = z.object({
  token: z.string().min(1),
  response: z.enum(['yes', 'no']),
  // A decline may carry a counter-proposal (#1982): a wall clock read on
  // `timeZone` (the page sends the browser's), or a zone-qualified instant.
  proposedAt: z.string().min(1).max(40).optional(),
  timeZone: z.string().max(80).optional(),
});

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'rsvp', { limit: 20, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { token, response, proposedAt: proposedRaw, timeZone } = parsed.data;
  if (proposedRaw && response !== 'no') return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
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
    // A guest has no relation to file a request in, so a counter is offered to
    // participants only (GET answers canCounter: false for a guest token).
    if (proposedRaw) return NextResponse.json({ error: 'Invalid request', code: 'counter_unavailable' }, { status: 400 });
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

  if (proposedRaw) {
    const counter = await fileCounterProposal(meeting, proposedRaw, timeZone);
    if ('error' in counter) return NextResponse.json({ error: 'Invalid request', code: counter.error }, { status: 400 });
    await prisma.meeting.update({ where: { id: meeting.id }, data: { rsvp: status } });
    return NextResponse.json({ ok: true, rsvp: status, counterProposal: { id: counter.id, proposedAt: counter.proposedAt } });
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

type CounterMeeting = {
  id: string;
  title: string;
  scheduledAt: Date | null;
  status: string;
  endedAt: Date | null;
  relationId: string | null;
  createdById: string;
  relation: { mentorId: string; menteeId: string } | null;
};

/**
 * "I can't make it — could we do this instead?" (#1982). The invitee of a
 * relation meeting files the alternative as a MeetingRequest pointing back at
 * the meeting (`counterOfMeetingId`), so it shows up in the same list the
 * organiser already works through, and accepting it moves THIS meeting through
 * the reschedule PATCH instead of booking a second one. One open counter per
 * meeting and person: suggesting again replaces the time.
 *
 * The token is the only credential, as for the yes/no answer itself: no session
 * is read, and the requester is the row's invitee, never a body field.
 */
async function fileCounterProposal(meeting: CounterMeeting, raw: string, timeZone: string | undefined) {
  if (!meeting.relationId || !meeting.relation || meeting.status !== 'SCHEDULED' || meeting.endedAt || !meeting.scheduledAt) {
    return { error: 'counter_unavailable' as const };
  }
  const rel = meeting.relation;
  const requestedById = rel.menteeId === meeting.createdById ? rel.mentorId : rel.menteeId;
  const invitee = await prisma.user.findUnique({ where: { id: requestedById }, select: { timezone: true } });
  // A bare wall clock is read on the clock it was picked on — the browser's,
  // else the invitee's saved zone — never the container's UTC (#1061).
  const proposedAt = parseUserDateTime(raw, isValidTimeZone(timeZone) ? timeZone : invitee?.timezone);
  if (!proposedAt || proposedAt.getTime() <= Date.now()) return { error: 'invalid_time' as const };

  const open = await prisma.meetingRequest.findFirst({
    where: { counterOfMeetingId: meeting.id, requestedById, status: 'PENDING' },
    select: { id: true },
  });
  const request = open
    ? await prisma.meetingRequest.update({ where: { id: open.id }, data: { proposedAt }, select: { id: true, proposedAt: true } })
    : await prisma.meetingRequest.create({
        data: { relationId: meeting.relationId, requestedById, topic: meeting.title, proposedAt, counterOfMeetingId: meeting.id },
        select: { id: true, proposedAt: true },
      });

  // The organiser is told on their own clock, in their own language.
  const organizer = await prisma.user.findUnique({
    where: { id: meeting.createdById },
    select: { timezone: true, preferredLanguage: true },
  });
  await notify(
    meeting.createdById,
    'rsvp.counterProposed',
    { title: meeting.title, when: formatInTimeZone(proposedAt, organizer?.timezone, undefined, intlLocaleFor(organizer?.preferredLanguage)) },
    `/mentor/mentees/${meeting.relationId}`,
  );
  return request;
}
