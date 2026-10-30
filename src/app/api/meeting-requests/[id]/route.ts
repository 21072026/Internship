import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { notify } from '@/lib/notify';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { sendMeetingRequestDecisionEmail } from '@/services/emailService';
import { meetingLinkRefusal, resolveMeetingLink } from '@/lib/meetingRoom';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { adoptProviderEvent, discardProviderEvent } from '@/lib/conferenceGeneration';
import { pushMeetingInBackground, pushableSelect } from '@/lib/googleCalendarSync';
import { meetingEnd } from '@/lib/meetingDuration';
import { bookWithoutConflict, conflictBody } from '@/lib/busyWindows';
import { findPolicyViolation, loadBookingPolicy, policyBody, policyExempt } from '@/lib/bookingPolicy';

const schema = z.object({ action: z.enum(['accept', 'decline']) });

// Email the requester the outcome (#668) — previously in-app only, so a mentee
// waiting on a slot had no way to learn it was confirmed. Opt-out respected and
// failures are logged, never surfaced as a failed decision.
async function emailDecision(
  requestedById: string,
  args: { topic: string; accepted: boolean; scheduledAt?: Date | null; meetLink?: string | null; link: string }
) {
  const user = await prisma.user.findUnique({
    where: { id: requestedById },
    select: { fullName: true, email: true, orgId: true, emailNotifications: true, notificationPrefs: true, timezone: true },
  });
  // The mail is the answer to a request this person filed, so the switch that
  // may silence it is the one for its own group: 'meeting-request-decision' is
  // meeting_invites. What stood here was `emailAllowed(user, 'meetingReminders')`,
  // a key belonging to a *different* group (meeting_reminders) — so an old
  // opt-out from automated nagging swallowed the reply someone was waiting for
  // while both preference surfaces kept showing "Meeting invites: ON".
  // 'meetingReminders' is now in meeting_invites.legacy instead, which keeps that
  // opt-out honoured and visible and lets an explicit opt-in override it.
  if (!user?.email || !emailGroupAllowedForCategory(user, 'meeting-request-decision')) return;
  try {
    // `requestedById` is the requester — the one who asked and is owed the
    // answer. The accepting mentor/admin is the actor, not the recipient.
    await sendMeetingRequestDecisionEmail({ to: user.email, fullName: user.fullName, orgId: user.orgId, timeZone: user.timezone, userId: requestedById, ...args });
  } catch (e) {
    console.error('Meeting request decision email failed:', e);
  }
}

// PATCH — the mentor (or admin) accepts or declines a meeting request.
// Accepting creates a confirmed Meeting (with an auto video link) and notifies
// the requester.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;

  return await withTenantScope(session, async () => {
  const req = await prisma.meetingRequest.findUnique({ where: { id }, include: { relation: true } });
  // MeetingRequest has no orgId and the nested include is never scoped: a
  // request on another tenant's relation reads as not found, before it can be
  // declined or turned into a meeting (#2542).
  if (!req || !(await inCallerTenant(req.relation.orgId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const rel = req.relation;
  // "Admin" is the permission layer's answer (#1571).
  const actor = await actorFromSession(session);
  const isAdmin = !!actor && (await can(actor, 'relation.write', undefined, session));
  const allowed = isAdmin || rel.mentorId === session.user.id;
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (req.status !== 'PENDING') return NextResponse.json({ error: 'Already handled' }, { status: 409 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const requesterLink = req.requestedById === rel.mentorId
    ? `/mentor/mentees/${rel.id}`
    : req.requestedById === rel.menteeId
      ? '/portal'
      : `/messages/${rel.id}`;

  if (parsed.data.action === 'decline') {
    await prisma.meetingRequest.update({ where: { id }, data: { status: 'DECLINED' } });
    await notify(req.requestedById, 'meeting_request.declined', {}, requesterLink);
    await emailDecision(req.requestedById, { topic: req.topic, accepted: false, link: requesterLink });
    return NextResponse.json({ ok: true, status: 'DECLINED' });
  }

  // A counter-proposal (#1982) is accepted by MOVING the meeting it counters —
  // through PATCH /api/meetings/[id], the one write path into a booked
  // meeting's time, which the panel calls first. This only records the answer,
  // and only once the meeting really sits at the proposed time: an accept
  // without the move would tell the requester "yes" about a meeting that never
  // moved, and creating a second meeting here is exactly what a counter is not.
  if (req.counterOfMeetingId) {
    const countered = await prisma.meeting.findUnique({
      where: { id: req.counterOfMeetingId },
      select: { scheduledAt: true, status: true, meetLink: true },
    });
    if (!countered || countered.status !== 'SCHEDULED' || countered.scheduledAt?.getTime() !== req.proposedAt.getTime()) {
      return NextResponse.json({ error: 'Move the meeting to the proposed time first', code: 'move_first' }, { status: 409 });
    }
    await prisma.meetingRequest.update({ where: { id }, data: { status: 'ACCEPTED' } });
    await notify(req.requestedById, 'meeting_request.accepted', { topic: req.topic }, requesterLink);
    await emailDecision(req.requestedById, {
      topic: req.topic,
      accepted: true,
      scheduledAt: countered.scheduledAt,
      meetLink: countered.meetLink,
      link: requesterLink,
    });
    return NextResponse.json({ ok: true, status: 'ACCEPTED', meetingId: req.counterOfMeetingId });
  }

  // Accept → create the confirmed meeting with an auto video link. A request
  // lives in one relation's thread (either side may file it), so the confirmed
  // meeting is structurally a 1:1 call: one mentor, one mentee. The room is
  // the MENTOR's — their saved personal room applies under a tenant policy
  // that wants one (#2007), whether the mentor or an admin clicked accept.
  // The wall clock behind `proposedAt` was typed by the *requester* (see
  // POST /api/meeting-requests), so theirs is the zone this time was agreed on —
  // not the mentor's, even though the mentor is the one confirming it (#1210).
  const requester = await prisma.user.findUnique({
    where: { id: req.requestedById },
    select: { timezone: true },
  });
  // The hour may have been taken since it was asked for (#1995): lock the pair,
  // check, write. A collision leaves the request PENDING — the mentor can still
  // decline it, or ask for another time in the thread.
  // The mentor's booking rules (#2003) set the length and, unless the mentor
  // is the one accepting — their own call to make — bind the booking too.
  const policy = await loadBookingPolicy(prisma, rel.mentorId);
  const durationMinutes = policy?.defaultSlotMinutes ?? null;
  const end = meetingEnd(req.proposedAt, { durationMinutes });
  // The room, now that the slot is known: under GENERATE_PROVIDER (#2009) a
  // Meet room on the MENTOR's own connected calendar.
  const resolved = await resolveMeetingLink({
    inviteeCount: 1,
    orgId: session.user.orgId,
    organizerId: rel.mentorId,
    conference: { title: req.topic, start: req.proposedAt, end, timeZone: requester?.timezone ?? null },
  });
  if (!resolved.ok) return meetingLinkRefusal(resolved);
  const link = resolved.link;
  const booked = await bookWithoutConflict(
    {
      viewer: session.user,
      userIds: [rel.mentorId, rel.menteeId],
      window: { start: req.proposedAt, end },
      extraCheck: policyExempt(session.user, rel.mentorId) ? undefined : (tx, external) => findPolicyViolation(tx, { mentorId: rel.mentorId, start: req.proposedAt, end, policy, external }),
    },
    (tx) =>
      tx.meeting.create({
        data: {
          relationId: rel.id,
          title: req.topic,
          scheduledAt: req.proposedAt,
          durationMinutes,
          timeZone: requester?.timezone ?? null,
          meetLink: link,
          rsvpToken: randomBytes(24).toString('hex'),
          createdById: session.user.id,
        },
        select: pushableSelect,
      }),
  );
  if (!booked.ok) {
    await discardProviderEvent(rel.mentorId, resolved.conference);
    return NextResponse.json(booked.conflict ? conflictBody(booked.conflict) : policyBody(booked.refused), { status: 409 });
  }
  const meeting = booked.result;
  await adoptProviderEvent([meeting.id], resolved.conference);
  // Mirror it into both participants' own calendars (#1986) — the accepted
  // request used to be the one scheduling path that never reached a calendar.
  // Fire-and-forget: a third party's API may not make accepting fail or hang.
  pushMeetingInBackground(meeting, [rel.mentorId, rel.menteeId]);
  await prisma.meetingRequest.update({ where: { id }, data: { status: 'ACCEPTED' } });
  await notify(req.requestedById, 'meeting_request.accepted', { topic: req.topic }, `/messages/${rel.id}`);
  await emailDecision(req.requestedById, {
    topic: req.topic,
    accepted: true,
    scheduledAt: meeting.scheduledAt,
    meetLink: meeting.meetLink,
    link: `/messages/${rel.id}`,
  });
  return NextResponse.json({ ok: true, status: 'ACCEPTED', meetingId: meeting.id });
  });
}
