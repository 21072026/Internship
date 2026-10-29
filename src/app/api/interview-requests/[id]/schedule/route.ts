import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { randomBytes } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { requireRoleOrPermission } from '@/lib/authz';
import { logActivity } from '@/lib/activity';
import { emit } from '@/lib/events/emit';
import { notify, notifyIfAllowed } from '@/lib/notify';
import { findActiveMentorship } from '@/lib/activeMentorship';
import { resolveMeetingLink, meetingLinkRefusal } from '@/lib/meetingRoom';
import { inviteGuests, normalizeGuests } from '@/lib/meetingGuests';
import { pushMeetingInBackground } from '@/lib/googleCalendarSync';
import { formatInTimeZone, isValidTimeZone } from '@/lib/timezone';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { resolveTemplateId } from '@/lib/evaluationTemplates';
import { resolveSetting } from '@/lib/settingsResolver';
import { settingsOrgOf } from '@/lib/settingsOrg';
import {
  intlLocaleFor,
  interviewRequestActorWhere,
  isProposedSlot,
  scheduleInterviewRequestSchema,
} from '@/lib/interviewRequests';

class NotApproved extends Error {}

/** The confirmed time as the recipient reads it: their zone, their language, the zone named (#1422). */
function confirmedTime(when: Date, timeZone: string | null | undefined, preferredLanguage: string | null | undefined): string {
  return formatInTimeZone(when, timeZone, undefined, intlLocaleFor(preferredLanguage));
}

// POST — turn an APPROVED interview request into a real Meeting (#1844): the
// approver picks one of the company's proposed slots (or another time, saying
// so with `override`), the Meeting is created and linked in both directions,
// the status becomes SCHEDULED, the company's interviewers are invited as
// MeetingGuests, and the mentee, the mentor and the company are told the
// confirmed time in their own zone and language. The status flip is a guarded
// updateMany inside the same transaction as the Meeting, so two concurrent
// calls produce one meeting and one 409.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Placement write (#2364).
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const role = session.user.role;
    // A COMPANY may cancel its own request (see ../cancel) but never schedules:
    // the interview is brokered by the programme (#807).
    const gate = await requireRoleOrPermission(['MENTOR'], 'company.write', { request });
    if ('error' in gate) return gate.error;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const parsed = scheduleInterviewRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed', details: parsed.error.flatten() }, { status: 400 });
    const { slot, timeZone, durationMinutes, meetLink, guestEmails, override, createPanel, interviewerIds } = parsed.data;
    if (!isValidTimeZone(timeZone)) return NextResponse.json({ error: 'Unknown time zone', code: 'invalid_time_zone' }, { status: 400 });
    const when = new Date(slot);
    if (Number.isNaN(when.getTime())) return NextResponse.json({ error: 'Invalid slot', code: 'validation_failed' }, { status: 400 });
    const { id } = await params;
    const scope = interviewRequestActorWhere({ role, userId: session.user.id, orgId });
    if (!scope) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    return withTenantScope(session, async () => {
      const current = await prisma.interviewRequest.findFirst({
        where: { id, ...scope },
        select: {
          id: true, status: true, menteeId: true, requisitionId: true, companyId: true, proposedSlots: true,
          requisition: { select: { title: true } },
          company: { select: { name: true } },
          mentee: { select: { id: true, email: true, fullName: true, timezone: true, preferredLanguage: true } },
        },
      });
      if (!current) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      if (current.status !== 'APPROVED') {
        return NextResponse.json({ error: 'Only an approved request can be scheduled', code: 'not_approved', status: current.status }, { status: 409 });
      }
      if (!override && !isProposedSlot(current.proposedSlots, slot)) {
        return NextResponse.json({ error: 'The slot is not one the company proposed', code: 'slot_not_proposed' }, { status: 400 });
      }
      // The Meeting hangs off the mentee's ACTIVE relation (#419: at most one).
      const relation = await findActiveMentorship(prisma, current.menteeId);
      if (!relation) return NextResponse.json({ error: 'The candidate has no active mentorship', code: 'no_active_relation' }, { status: 409 });

      // The room: pasted link → the organiser's saved room → a room of ours,
      // as the tenant's policy says (#2007); refused under REQUIRE_EXTERNAL.
      const resolved = await resolveMeetingLink({
        pastedLink: meetLink,
        inviteeCount: 2 + (guestEmails?.length ?? 0),
        orgId: session.user.orgId,
        organizerId: session.user.id,
      });
      if (!resolved.ok) return meetingLinkRefusal(resolved);

      // Interviewers are addresses, never accounts: an address that already
      // belongs to a user of this world is reached as a participant instead.
      const { guests, rejectedAsMembers } = await normalizeGuests(
        (guestEmails ?? []).map((email) => ({ email })),
        [current.mentee.email, ...(session.user.email ? [session.user.email] : [])],
        session.user.orgId,
      );

      const title = `Interview · ${current.requisition.title} · ${current.company.name}`;

      // The scorecard panel (#1846), convened in the same transaction as the
      // meeting so its scheduledAt is the meeting's. Everyone on it has to be a
      // real, active account that can sign in and score (the rule of
      // POST /api/interview-panels); a ghost member would block completion.
      const interviewers = createPanel
        ? await prisma.user.findMany({
            where: { id: { in: [...new Set(interviewerIds ?? [])] }, orgId, isActive: true, role: { in: ['ADMIN', 'MENTOR'] } },
            select: { id: true },
          })
        : [];
      if (createPanel && interviewers.length === 0) {
        return NextResponse.json({ error: 'No valid interviewers', code: 'no_valid_interviewers' }, { status: 400 });
      }
      const templateId = createPanel ? await resolveTemplateId(orgId, 'MENTEE') : null;

      let created: { meetingId: string; panelId: string | null };
      try {
        created = await prisma.$transaction(async (tx) => {
          const meeting = await tx.meeting.create({
            data: {
              relationId: relation.id,
              title,
              scheduledAt: when,
              durationMinutes: durationMinutes ?? null,
              timeZone,
              meetLink: resolved.link,
              rsvpToken: randomBytes(24).toString('hex'),
              createdById: session.user.id,
            },
            select: { id: true },
          });
          const panel = createPanel
            ? await tx.interviewPanel.create({
                data: {
                  orgId,
                  subjectId: current.menteeId,
                  title,
                  scheduledAt: when,
                  createdById: session.user.id,
                  templateId,
                  meetingId: meeting.id,
                  members: { create: interviewers.map((i) => ({ userId: i.id })) },
                },
                select: { id: true },
              })
            : null;
          // The guard: the status the checks above saw is in the WHERE, so the
          // loser of a race rolls its meeting (and panel) back and answers 409.
          const changed = await tx.interviewRequest.updateMany({
            where: { id: current.id, orgId, status: 'APPROVED' },
            data: { status: 'SCHEDULED', meetingId: meeting.id, scheduledAt: when, ...(panel ? { panelId: panel.id } : {}) },
          });
          if (changed.count !== 1) throw new NotApproved();
          await tx.auditLog.create({
            data: {
              actorId: session.user.id,
              action: 'INTERVIEW_REQUEST_SCHEDULED',
              targetId: current.id,
              orgId,
              detail: `meeting=${meeting.id}; at=${when.toISOString()}; zone=${timeZone}; mentee=${current.menteeId}; requisition=${current.requisitionId}${override ? '; override' : ''}${panel ? `; panel=${panel.id}` : ''}`,
            },
          });
          return { meetingId: meeting.id, panelId: panel?.id ?? null };
        });
      } catch (e) {
        if (e instanceof NotApproved) {
          return NextResponse.json({ error: 'The request changed meanwhile', code: 'not_approved' }, { status: 409 });
        }
        throw e;
      }

      const meeting = await prisma.meeting.findUniqueOrThrow({
        where: { id: created.meetingId },
        select: { id: true, title: true, scheduledAt: true, durationMinutes: true, timeZone: true, meetLink: true, rsvpToken: true, relationId: true, createdById: true },
      });

      // Guests are invited only once the meeting exists: a mail with a token
      // that resolves to nothing is worse than no mail at all.
      const invitedGuests = guests.length > 0
        ? await inviteGuests({
            meetingId: meeting.id,
            guests,
            invitedById: session.user.id,
            title,
            scheduledAt: when,
            meetLink: meeting.meetLink,
            organizerTimeZone: timeZone,
            organizerName: session.user.name ?? null,
            durationMinutes: meeting.durationMinutes,
          })
        : [];

      // Into the calendars of whoever connected their own (#709) — organiser,
      // mentor and mentee; fire-and-forget, a third party can never fail this.
      // The panel's interviewers sit on the calendar too (#1846).
      pushMeetingInBackground(meeting, [...new Set([session.user.id, relation.mentorId, current.mentee.id, ...interviewers.map((i) => i.id)])]);

      if (created.panelId) {
        // Under blind review the assignment must not name the candidate (#819).
        const blindEnabled = await resolveSetting('blindReview', { orgId: await settingsOrgOf(session) });
        for (const interviewer of interviewers) {
          await (blindEnabled
            ? notifyIfAllowed(interviewer.id, 'goalsEvaluations', 'interview.assignedBlind', undefined, `/interviews/${created.panelId}`)
            : notifyIfAllowed(interviewer.id, 'goalsEvaluations', 'interview.assigned', { name: current.mentee.fullName }, `/interviews/${created.panelId}`));
        }
        await logActivity({
          action: 'interview_panel.created',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'interviewPanel',
          targetId: created.panelId,
          detail: `${current.mentee.fullName} · ${interviewers.length} interviewers · meeting=${meeting.id}`,
          request,
          orgId,
        });
      }

      try {
        await sendMeetingInviteEmail({
          to: current.mentee.email,
          fullName: current.mentee.fullName,
          title,
          scheduledAt: when,
          meetLink: meeting.meetLink,
          rsvpToken: meeting.rsvpToken,
          timeZone: current.mentee.timezone,
          organizerTimeZone: timeZone,
          organizerName: session.user.name ?? null,
          userId: current.mentee.id,
          locale: current.mentee.preferredLanguage,
          orgId: session.user.orgId,
          icsUid: meeting.id,
          durationMinutes: meeting.durationMinutes,
        });
      } catch (e) {
        console.error('Interview invite email failed:', e);
      }

      // Everyone hears the CONFIRMED time, on their own clock (#1422).
      const link = `/company/requisitions/${current.requisitionId}`;
      await notify(current.mentee.id, 'interview_request.scheduled', { title: current.requisition.title, when: confirmedTime(when, current.mentee.timezone, current.mentee.preferredLanguage) }, '/portal');
      if (relation.mentorId !== session.user.id) {
        const mentor = await prisma.user.findUnique({ where: { id: relation.mentorId }, select: { timezone: true, preferredLanguage: true } });
        await notifyIfAllowed(relation.mentorId, 'meetingReminders', 'interview_request.scheduled', { title: current.requisition.title, when: confirmedTime(when, mentor?.timezone, mentor?.preferredLanguage) }, '/mentor/meetings');
      }
      const companyUsers = await prisma.user.findMany({
        where: { orgId, companyId: current.companyId, role: 'COMPANY', isActive: true },
        select: { id: true, timezone: true, preferredLanguage: true },
      });
      for (const user of companyUsers) {
        await notifyIfAllowed(user.id, 'mentorship', 'interview_request.scheduled', { title: current.requisition.title, when: confirmedTime(when, user.timezone, user.preferredLanguage) }, link);
      }
      await logActivity({
        action: 'interview_request.scheduled',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'interview_request',
        targetId: current.id,
        detail: `meeting=${meeting.id}; at=${when.toISOString()}; zone=${timeZone}; guests=${invitedGuests.length}`,
        request,
        orgId,
      });
      // Ids only (#1998): no title, guest address or mentee name on the bus.
      await emit(
        'interview_request.scheduled',
        { requestId: current.id, meetingId: meeting.id, scheduledAt: when.toISOString(), panelId: created.panelId },
        { orgId, actor: { id: session.user.id, type: 'user' } },
      );

      return NextResponse.json({
        ok: true,
        status: 'SCHEDULED',
        meetingId: meeting.id,
        panelId: created.panelId,
        scheduledAt: when.toISOString(),
        timeZone,
        guests: invitedGuests,
        rejectedGuests: rejectedAsMembers,
      });
    });
  });
}
