import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { emailGroupAllowedForCategory } from '@/lib/emailGroups';
import { sendMentorshipDecisionEmail, sendMenteeAssignedEmail } from '@/services/emailService';
import { checkActiveRelationLimitForMentee, planLimitError } from '@/lib/planGate';
import { getMentorAvailability } from '@/lib/mentorAvailability';

// Deciding a MentorshipRequest — extracted from the admin queue route (#590)
// so the mentor's own accept/reject step (#1188) shares one behavior: same
// plan gate, same relation creation, same notifications and decision e-mails.
// The two callers differ only in authorization: an admin decides any request
// with any mentor; a mentor decides only requests that name THEM as the
// preferred mentor, and can only assign themself.

export interface DecisionResult {
  status: number;
  body: Record<string, unknown>;
}

export async function decideMentorshipRequest(opts: {
  requestId: string;
  action: 'approve' | 'reject';
  // The mentor the approved relation is created with (approve only).
  mentorId?: string;
  actorId: string;
  actorEmail?: string | null;
  // Mentor-facing route: the request must carry this preferredMentorId, or the
  // caller may not touch it (server-side authorization, not a UI filter).
  restrictToPreferredMentorId?: string;
  request?: Request;
}): Promise<DecisionResult> {
  const { requestId, action, mentorId, actorId, actorEmail, restrictToPreferredMentorId, request } = opts;

  const req = await prisma.mentorshipRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      menteeId: true,
      preferredMentorId: true,
      mentee: {
        select: { fullName: true, email: true, orgId: true, emailNotifications: true, notificationPrefs: true },
      },
    },
  });
  if (!req) return { status: 404, body: { error: 'Not found' } };
  if (restrictToPreferredMentorId && req.preferredMentorId !== restrictToPreferredMentorId) {
    // Same shape as not-found on purpose: a mentor probing other requests'
    // ids learns nothing about their existence.
    return { status: 404, body: { error: 'Not found' } };
  }
  if (req.status !== 'PENDING') {
    return { status: 409, body: { error: 'Request already decided', code: 'already_decided' } };
  }

  if (action === 'approve') {
    if (!mentorId) return { status: 400, body: { error: 'mentorId is required to approve' } };
    const mentor = await prisma.user.findUnique({
      where: { id: mentorId },
      select: {
        id: true,
        role: true,
        isActive: true,
        fullName: true,
        email: true,
        orgId: true,
        emailNotifications: true,
        notificationPrefs: true,
        mentorCapacity: true,
        acceptingMentees: true,
      },
    });
    if (!mentor || !mentor.isActive || (mentor.role !== 'MENTOR' && mentor.role !== 'ADMIN')) {
      return { status: 400, body: { error: 'Invalid mentor' } };
    }
    const existing = await prisma.mentorshipRelation.findFirst({
      where: { menteeId: req.menteeId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (existing) {
      return { status: 409, body: { error: 'Mentee already has an active mentorship', code: 'already_mentored' } };
    }

    // Plan gate (#547): approving a request creates a new active relation.
    const gate = await checkActiveRelationLimitForMentee(req.menteeId);
    if (!gate.allowed) {
      return { status: 403, body: planLimitError(gate) };
    }

    // Capacity/availability warning (#942): advisory only, mirrors POST
    // /api/mentorship (direct assignment) — same getMentorAvailability()
    // helper, same "count ACTIVE relations *before* this new one" semantics.
    // Never blocks the approval; only the plan gate above can do that.
    const activeMenteeCount = await prisma.mentorshipRelation.count({
      where: { mentorId, status: 'ACTIVE' },
    });
    const availability = getMentorAvailability({
      mentorCapacity: mentor.mentorCapacity,
      activeMenteeCount,
      acceptingMentees: mentor.acceptingMentees,
    });
    const warnings: string[] =
      availability.status === 'at_capacity'
        ? ['mentor_at_capacity']
        : availability.status === 'not_accepting'
          ? ['mentor_not_accepting']
          : [];

    const [relation] = await prisma.$transaction([
      prisma.mentorshipRelation.create({ data: { mentorId, menteeId: req.menteeId, orgId: gate.orgId } }),
      prisma.mentorshipRequest.update({
        where: { id: req.id },
        data: { status: 'APPROVED', decidedById: actorId, decidedAt: new Date() },
      }),
    ]);
    await notify(req.menteeId, 'mentorship_request.approved', {}, '/portal');
    // The mentor deciding their own queue doesn't need to be told about
    // themself — no echo (#886 rule).
    if (mentorId !== actorId) {
      await notify(mentorId, 'mentorship_request.menteeAssigned', { menteeName: req.mentee.fullName }, '/mentor');
    }

    // Email both sides (#668) — the decision used to be in-app only, so a mentee
    // who wasn't logged in never learned they had a mentor. Opt-out respected;
    // failures are logged and never fail the approval.
    if (
      req.mentee.email &&
      emailAllowed(req.mentee, 'mentorship') &&
      emailGroupAllowedForCategory(req.mentee, 'mentorship-decision')
    ) {
      try {
        await sendMentorshipDecisionEmail({
          to: req.mentee.email,
          fullName: req.mentee.fullName,
          approved: true,
          mentorName: mentor.fullName,
          orgId: req.mentee.orgId,
          // The mentee is the recipient of the decision mail — not `actorId`,
          // which is the admin (or the mentor) who pressed the button.
          userId: req.menteeId,
        });
      } catch (e) {
        console.error('Mentorship approval email failed:', e);
      }
    }
    if (
      mentor.email &&
      mentorId !== actorId &&
      emailAllowed(mentor, 'mentorship') &&
      emailGroupAllowedForCategory(mentor, 'mentee-assigned')
    ) {
      try {
        await sendMenteeAssignedEmail({
          to: mentor.email,
          mentorName: mentor.fullName,
          menteeName: req.mentee.fullName,
          orgId: mentor.orgId,
          // This half of the pair goes to the MENTOR, so the token and the
          // preference lookup are the mentor's, not the mentee's.
          userId: mentor.id,
        });
      } catch (e) {
        console.error('Mentee assignment email failed:', e);
      }
    }
    await logActivity({
      action: 'mentorship_request.decided',
      actorId,
      actorEmail: actorEmail ?? null,
      targetType: 'mentorship_request',
      targetId: req.id,
      detail: `approved · mentor ${mentorId}`,
      request,
    });
    return { status: 200, body: { ok: true, relationId: relation.id, warnings } };
  }

  await prisma.mentorshipRequest.update({
    where: { id: req.id },
    data: { status: 'REJECTED', decidedById: actorId, decidedAt: new Date() },
  });
  await logActivity({
    action: 'mentorship_request.decided',
    actorId,
    actorEmail: actorEmail ?? null,
    targetType: 'mentorship_request',
    targetId: req.id,
    detail: 'rejected',
    request,
  });
  await notify(req.menteeId, 'mentorship_request.rejected', {}, '/portal');
  if (
    req.mentee.email &&
    emailAllowed(req.mentee, 'mentorship') &&
    emailGroupAllowedForCategory(req.mentee, 'mentorship-decision')
  ) {
    try {
      await sendMentorshipDecisionEmail({
        to: req.mentee.email,
        fullName: req.mentee.fullName,
        approved: false,
        orgId: req.mentee.orgId,
        userId: req.menteeId,
      });
    } catch (e) {
      console.error('Mentorship rejection email failed:', e);
    }
  }
  return { status: 200, body: { ok: true } };
}
