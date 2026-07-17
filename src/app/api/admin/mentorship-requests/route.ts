import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { checkActiveRelationLimitForMentee, planLimitError } from '@/lib/planGate';

// Admin queue for mentee mentorship requests (#590): list PENDING requests,
// approve (pick a mentor → MentorshipRelation) or reject. The mentee is
// notified of the decision either way.

// GET — requests, PENDING by default (?status=APPROVED|REJECTED for history).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
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

  const parsed = decideSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { requestId, action, mentorId } = parsed.data;

  const req = await prisma.mentorshipRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, menteeId: true, mentee: { select: { fullName: true } } },
  });
  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (req.status !== 'PENDING') {
    return NextResponse.json({ error: 'Request already decided', code: 'already_decided' }, { status: 409 });
  }

  if (action === 'approve') {
    if (!mentorId) return NextResponse.json({ error: 'mentorId is required to approve' }, { status: 400 });
    const mentor = await prisma.user.findUnique({ where: { id: mentorId }, select: { id: true, role: true, isActive: true } });
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
    return NextResponse.json({ ok: true, relationId: relation.id });
  }

  await prisma.mentorshipRequest.update({
    where: { id: req.id },
    data: { status: 'REJECTED', decidedById: session.user.id, decidedAt: new Date() },
  });
  await notify(req.menteeId, 'mentorship_request', 'Your mentorship request was reviewed but could not be approved right now.', '/portal');
  return NextResponse.json({ ok: true });
}
