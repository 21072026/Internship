import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { decideMentorshipRequest } from '@/lib/mentorshipDecision';
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

  // Shared with the mentor's own accept/reject step (#1188) — one behavior,
  // two authorizations (an admin may decide any request with any mentor).
  const result = await decideMentorshipRequest({
    requestId,
    action,
    mentorId,
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    request,
  });
  return NextResponse.json(result.body, { status: result.status });
  });
}
