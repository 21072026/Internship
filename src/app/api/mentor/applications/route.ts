import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { decideMentorshipRequest } from '@/lib/mentorshipDecision';
import { withTenantScope } from '@/lib/orgContext';

// The mentor's own application inbox (#1188): public /apply/[mentorId]
// submissions now land here as PENDING MentorshipRequests naming this mentor,
// and the mentor accepts (creating the relation) or politely declines — both
// notify + e-mail the applicant via the shared decision service. Server-side
// authorization throughout: only requests whose preferredMentorId is the
// caller are visible or decidable.

// GET — my pending applications, oldest first.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const requests = await prisma.mentorshipRequest.findMany({
      where: { status: 'PENDING', preferredMentorId: session.user.id },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        id: true,
        message: true,
        targetPosition: true,
        preferredField: true,
        preferredLanguages: true,
        createdAt: true,
        mentee: { select: { id: true, fullName: true, university: true, department: true, city: true, skills: true } },
      },
    });
    return NextResponse.json({ requests });
  });
}

const decideSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(['accept', 'reject']),
});

// PUT — accept (relation with ME) or reject. No mentorId parameter exists on
// purpose: a mentor can only ever assign themself.
export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const parsed = decideSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    const result = await decideMentorshipRequest({
      requestId: parsed.data.requestId,
      action: parsed.data.action === 'accept' ? 'approve' : 'reject',
      mentorId: session.user.id,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      restrictToPreferredMentorId: session.user.id,
      request,
    });
    return NextResponse.json(result.body, { status: result.status });
  });
}
