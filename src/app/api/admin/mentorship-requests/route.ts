import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { emailAllowed } from '@/lib/notificationPrefs';
import { sendMentorshipDecisionEmail, sendMenteeAssignedEmail } from '@/services/emailService';
import { checkActiveRelationLimitForMentee, planLimitError } from '@/lib/planGate';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { withTenantScope } from '@/lib/orgContext';

// Admin queue for mentee mentorship requests (#590): list PENDING requests,
// approve (pick a mentor → MentorshipRelation) or reject. The mentee is
// notified of the decision either way.

// GET — requests, PENDING by default (?status=APPROVED|REJECTED for history).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
  const statusParam = new URL(request.url).searchParams.get('status');
  const status = statusParam === 'APPROVED' || statusParam === 'REJECTED' ? statusParam : 'PENDING';

  const requests = await prisma.mentorshipRequest.findMany({
    where: { status },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: {
      id: true,
      status: true,
      message: true,
      targetPosition: true,
      preferredField: true,
      preferredLanguages: true,
      preferredMentor: { select: { id: true, fullName: true } },
      createdAt: true,
      mentee: { select: { id: true, fullName: true, email: true, university: true, skills: true } },
    },
  });
  return NextResponse.json({ requests });
  });
}

const decideSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(['approve', 'reject']),
  mentorId: z.string().min(1).optional(),
});

// PUT — decide a request. Approving requires a mentorId and creates the
// MentorshipRelation (unless the mentee got one in the meantime).
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const parsed = decideSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { requestId, action, mentorId } = parsed.data;

  const req = await prisma.mentorshipRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      menteeId: true,
      message: true,
      mentee: {
        select: { fullName: true, email: true, orgId: true, emailNotifications: true, notificationPrefs: true },
      },
    },
  });
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (req.status !== 'PENDING') {
    return NextResponse.json({ error: 'Request already decided', code: 'already_decided' }, { status: 409 });
  }

  if (action === 'approve') {
    if (!mentorId) return NextResponse.json({ error: 'mentorId is required to approve' }, { status: 400 });
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
      return NextResponse.json({ error: 'Invalid mentor' }, { status: 400 });
    }
    const existing = await prisma.mentorshipRelation.findFirst({ where: { menteeId: req.menteeId, status: 'ACTIVE' }, select: { id: true } });
    if (existing) {
      return NextResponse.json({ error: 'Mentee already has an active mentorship', code: 'already_mentored' }, { status: 409 });
    }

    // Plan gate (#547): approving a request creates a new active relation.
    const gate = await checkActiveRelationLimitForMentee(req.menteeId);
    if (!gate.allowed) {
      return NextResponse.json(planLimitError(gate), { status: 403 });
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
        data: { status: 'APPROVED', decidedById: session.user.id, decidedAt: new Date() },
      }),
    ]);
    await notify(req.menteeId, 'mentorship_request.approved', {}, '/portal');
    await notify(mentorId, 'mentorship_request.menteeAssigned', { menteeName: req.mentee.fullName }, '/mentor');

    // Email both sides (#668) — the decision used to be in-app only, so a mentee
    // who wasn't logged in never learned they had a mentor. Opt-out respected;
    // failures are logged and never fail the approval.
    if (req.mentee.email && emailAllowed(req.mentee, 'mentorship')) {
      try {
        await sendMentorshipDecisionEmail({
          to: req.mentee.email,
          fullName: req.mentee.fullName,
          approved: true,
          mentorName: mentor.fullName,
          orgId: req.mentee.orgId,
        });
      } catch (e) {
        console.error('Mentorship approval email failed:', e);
      }
    }
    if (mentor.email && emailAllowed(mentor, 'mentorship')) {
      try {
        await sendMenteeAssignedEmail({
          to: mentor.email,
          mentorName: mentor.fullName,
          menteeName: req.mentee.fullName,
          orgId: mentor.orgId,
        });
      } catch (e) {
        console.error('Mentee assignment email failed:', e);
      }
    }
    await logActivity({
      action: 'mentorship_request.decided',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'mentorship_request',
      targetId: req.id,
      detail: `approved · mentor ${mentorId}`,
      request,
    });
    return NextResponse.json({ ok: true, relationId: relation.id, warnings });
  }

  await prisma.mentorshipRequest.update({
    where: { id: req.id },
    data: { status: 'REJECTED', decidedById: session.user.id, decidedAt: new Date() },
  });
  await logActivity({
    action: 'mentorship_request.decided',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'mentorship_request',
    targetId: req.id,
    detail: 'rejected',
    request,
  });
  await notify(req.menteeId, 'mentorship_request.rejected', {}, '/portal');
  if (req.mentee.email && emailAllowed(req.mentee, 'mentorship')) {
    try {
      await sendMentorshipDecisionEmail({
        to: req.mentee.email,
        fullName: req.mentee.fullName,
        approved: false,
        orgId: req.mentee.orgId,
      });
    } catch (e) {
      console.error('Mentorship rejection email failed:', e);
    }
  }
  return NextResponse.json({ ok: true });
  });
}
