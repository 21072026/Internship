import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { checkActiveRelationLimitForMentee, planLimitError } from '@/lib/planGate';
import { withTenantScope } from '@/lib/orgContext';
import { emailAllowed } from '@/lib/notificationPrefs';
import { sendEmail } from '@/services/emailService';

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
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const req = await prisma.mentorshipRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      menteeId: true,
      mentee: { select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true } },
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
      select: { id: true, role: true, isActive: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
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

    const [relation] = await prisma.$transaction([
      prisma.mentorshipRelation.create({ data: { mentorId, menteeId: req.menteeId, orgId: gate.orgId } }),
      prisma.mentorshipRequest.update({
        where: { id: req.id },
        data: { status: 'APPROVED', decidedById: session.user.id, decidedAt: new Date() },
      }),
    ]);
    await notify(req.menteeId, 'mentorship_request', 'Your mentorship request was approved — say hi to your mentor!', '/portal');
    await notify(mentorId, 'mentorship_request', `A new mentee was assigned to you: ${req.mentee.fullName}.`, '/mentor');

    // Opt-in email mirror — fired only after the transaction above committed.
    if (emailAllowed(req.mentee, 'mentorshipRequests')) {
      try {
        await sendEmail({
          to: req.mentee.email,
          subject: 'Your mentorship request was approved',
          html: `<p>Hi ${req.mentee.fullName},</p><p>Your mentorship request was approved — say hi to your mentor!</p><p><a href="${appUrl}/portal">Open your portal</a></p>`,
        });
      } catch (e) {
        console.error('Mentorship request approved email failed:', { recipientRole: 'MENTEE', userId: req.menteeId, error: e });
      }
    }
    if (emailAllowed(mentor, 'mentorshipRequests')) {
      try {
        await sendEmail({
          to: mentor.email,
          subject: `New mentee assigned: ${req.mentee.fullName}`,
          html: `<p>Hi ${mentor.fullName},</p><p>A new mentee was assigned to you: <strong>${req.mentee.fullName}</strong>.</p><p><a href="${appUrl}/mentor">Open your dashboard</a></p>`,
        });
      } catch (e) {
        console.error('Mentorship request approved email failed:', { recipientRole: 'MENTOR', userId: mentor.id, error: e });
      }
    }

    return NextResponse.json({ ok: true, relationId: relation.id });
  }

  await prisma.mentorshipRequest.update({
    where: { id: req.id },
    data: { status: 'REJECTED', decidedById: session.user.id, decidedAt: new Date() },
  });
  await notify(req.menteeId, 'mentorship_request', 'Your mentorship request was reviewed but could not be approved right now.', '/portal');

  // Opt-in email mirror — fired only after the status update above committed.
  if (emailAllowed(req.mentee, 'mentorshipRequests')) {
    try {
      await sendEmail({
        to: req.mentee.email,
        subject: 'Update on your mentorship request',
        html: `<p>Hi ${req.mentee.fullName},</p><p>Your mentorship request was reviewed but could not be approved right now.</p><p><a href="${appUrl}/portal">Open your portal</a></p>`,
      });
    } catch (e) {
      console.error('Mentorship request rejected email failed:', { recipientRole: 'MENTEE', userId: req.menteeId, error: e });
    }
  }
  return NextResponse.json({ ok: true });
  });
}
