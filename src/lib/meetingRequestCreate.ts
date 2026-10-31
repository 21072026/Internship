// Moved out of src/app/api/meeting-requests/route.ts (#1951) so the chat
// booking flow calls the same code; see createMeetingRequest().
import type { Session } from 'next-auth';
import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { z } from 'zod';
import { getThreadIfAllowed, otherParticipant } from '@/lib/messaging';
import { notify } from '@/lib/notify';
import { notifyEvent } from '@/lib/notifications/router';
import { chatCapableUsers } from '@/lib/notifications/adapters/chat';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { sendMeetingRequestEmail } from '@/services/emailService';
import { parseUserDateTime } from '@/lib/timezone';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { meetingEnd } from '@/lib/meetingDuration';
import { conflictBody, findConflictFor, EXTERNAL_PAD_MS } from '@/lib/busyWindows';
import { providerBusy } from '@/lib/calendarFreeBusy';
import { findPolicyViolation, loadBookingPolicy, policyBody, policyExempt } from '@/lib/bookingPolicy';

const schema = z.object({
  relationId: z.string().min(1),
  topic: z.string().min(1).max(TEXT_LIMITS.meetingTopic),
  proposedAt: z.string().min(1),
});

/**
 * A participant (typically the mentee) requests a meeting — the ONE path that
 * writes a MeetingRequest (#1951): POST /api/meeting-requests and the chat
 * "book a session" pick both call it with the caller's session, so the
 * thread check, the archive refusal, the conflict and booking-rule checks and
 * the mentor's bell + mail are the same whichever door the request came in by.
 * Answers the HTTP response the route returns.
 */
export async function createMeetingRequest(session: Session, input: unknown): Promise<NextResponse> {
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  return await withTenantScope(session, async () => {
  const rel = await getThreadIfAllowed(session.user, parsed.data.relationId);
  if (!rel || !(await inCallerTenant(rel.orgId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // A finished mentorship takes no new ones (#1408) — the portal hides the form
  // on an archive, and this keeps a hand-rolled request from doing more.
  if (menteeWriteClosed(rel, session.user.id)) {
    return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
  }

  // The panel sends a zone-qualified instant; a bare wall clock is anchored to
  // the requester's zone rather than the container's UTC (#1061).
  // Loaded unconditionally since #1210: the zone is needed for the mentor's
  // email even when the instant arrived fully qualified and needed no anchoring.
  const requester = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { timezone: true },
  });
  const proposedAt = parseUserDateTime(parsed.data.proposedAt, requester?.timezone);
  if (!proposedAt) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  // Asking for an hour the pair already has booked is answered now, not when
  // the mentor tries to accept it (#1995). Accepting re-checks under a lock.
  // A session is as long as the mentor says (#2003), or the default.
  const policy = await loadBookingPolicy(prisma, rel.mentorId);
  const proposedEnd = meetingEnd(proposedAt, { durationMinutes: policy?.defaultSlotMinutes ?? null });
  // Both people's real calendars count too (#1997).
  const external = await providerBusy([rel.mentorId, rel.menteeId], new Date(proposedAt.getTime() - EXTERNAL_PAD_MS), new Date(proposedEnd.getTime() + EXTERNAL_PAD_MS));
  const conflict = await findConflictFor(prisma, session.user, [rel.mentorId, rel.menteeId], { start: proposedAt, end: proposedEnd }, { external });
  if (conflict) return NextResponse.json(conflictBody(conflict), { status: 409 });
  // …and the mentor's booking rules, named so the panel can say which (#2003).
  if (!policyExempt(session.user, rel.mentorId)) {
    const violation = await findPolicyViolation(prisma, { mentorId: rel.mentorId, start: proposedAt, end: proposedEnd, policy, external });
    if (violation) return NextResponse.json(policyBody(violation), { status: 409 });
  }

  const req = await prisma.meetingRequest.create({
    data: {
      relationId: rel.id,
      requestedById: session.user.id,
      topic: parsed.data.topic,
      proposedAt,
    },
  });

  // Notify the other party (the mentor) of the request.
  const recipient = otherParticipant(rel, session.user.id);
  if (recipient && recipient !== session.user.id) {
    const link = recipient === rel.mentorId ? `/mentor/mentees/${rel.id}` : '/portal';
    const requesterName = session.user.name;
    await notify(
      recipient,
      requesterName ? 'meeting_request.new' : 'meeting_request.newGeneric',
      requesterName ? { from: requesterName } : {},
      link
    );
    // …and a chat card for a recipient who linked chat (#1951): the bell row
    // above keeps its own deep link, so the router is asked for chat only.
    // The mentor's card answers the request in place — Accept/Decline post to
    // the interaction endpoint, which calls decideMeetingRequest() as them.
    if ((await chatCapableUsers([recipient])).has(recipient)) {
      const chatCard = {
        subjectKey: `meeting-request:${req.id}`,
        actionUrl: null,
        supersede: false,
        buttons:
          recipient === rel.mentorId
            ? [
                { label: 'accept' as const, actionId: 'meeting_request.accept', value: req.id },
                { label: 'decline' as const, actionId: 'meeting_request.decline', value: req.id },
              ]
            : [],
      };
      const opts = { channels: ['chat'] as const, dedupeKey: `meeting-request:${req.id}`, chatCard };
      if (requesterName) await notifyEvent(recipient, 'meeting_request.new', { from: requesterName }, opts);
      else await notifyEvent(recipient, 'meeting_request.newGeneric', {}, opts);
    }

    // Email it too (#668) — a request the mentor never sees is a request that
    // never gets answered. Opt-out respected, failures logged.
    const rcpt = await prisma.user.findUnique({
      where: { id: recipient },
      select: { fullName: true, email: true, orgId: true, emailNotifications: true, notificationPrefs: true, timezone: true },
    });
    // Gated on this mail's OWN group: 'meeting-request' is meeting_invites.
    // The check used to read `emailAllowed(rcpt, 'meetingReminders')`, a key that
    // maps to meeting_reminders — a different group — so an old opt-out from
    // automated nagging silently swallowed a named person asking you to attend
    // something, while both preference surfaces showed "Meeting invites: ON".
    // 'meetingReminders' is now in meeting_invites.legacy, so that opt-out still
    // holds, is visible, and can be overridden by an explicit opt-in.
    if (rcpt?.email && emailGroupAllowedForCategory(rcpt, 'meeting-request')) {
      try {
        await sendMeetingRequestEmail({
          to: rcpt.email,
          fullName: rcpt.fullName,
          requesterName: session.user.name ?? 'Your mentee',
          topic: req.topic,
          proposedAt: req.proposedAt,
          link,
          orgId: rcpt.orgId,
          timeZone: rcpt.timezone,
          requesterTimeZone: requester?.timezone ?? null,
          // The other party, i.e. whoever is being asked to attend — not
          // `session.user.id`, who is the person asking.
          userId: recipient,
        });
      } catch (e) {
        console.error('Meeting request email failed:', e);
      }
    }
  }
  return NextResponse.json({ request: req }, { status: 201 });
  });
}
