import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { decideMentorshipRequest } from '@/lib/mentorshipDecision';
import { withTenantScope } from '@/lib/orgContext';
import { ENDED_REMATCHED } from '@/lib/relationLifecycle';

// Admin queue for mentee mentorship requests (#590): list PENDING requests,
// approve (pick a mentor → MentorshipRelation) or reject. The mentee is
// notified of the decision either way.
//
// Re-match requests (#1801) share this queue and are sorted to the top: the
// mentee is sitting in a pairing they have said is not working, so they are the
// time-sensitive ones. This handler is THE ONLY read path that returns
// `rematchReason`/`rematchNote`, and it is ADMIN-only — the mentee's words about
// their mentor never reach that mentor, not through the incoming mentor's inbox
// (which filters re-matches out) and not through any mail.

/** Window the programme-health counts below are computed over. */
const REMATCH_STATS_DAYS = 90;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
  const statusParam = new URL(request.url).searchParams.get('status');
  const status = statusParam === 'APPROVED' || statusParam === 'REJECTED' ? statusParam : 'PENDING';
  const since = new Date(Date.now() - REMATCH_STATS_DAYS * 24 * 60 * 60 * 1000);

  const [requests, rematched, endedTotal, byReason] = await Promise.all([
    prisma.mentorshipRequest.findMany({
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
        // Re-match payload — admins only, see the header comment.
        replacesRelationId: true,
        rematchReason: true,
        rematchNote: true,
        replacesRelation: {
          select: { id: true, startDate: true, mentor: { select: { id: true, fullName: true } } },
        },
      },
    }),
    // Programme health (#1801): a re-match is a signal worth counting, not an
    // embarrassment to hide — so it is reported next to the closures rather
    // than folded into them. ENDED_REMATCHED is never a completion.
    prisma.mentorshipRelation.count({
      where: { lifecycleState: ENDED_REMATCHED, completedAt: { gte: since } },
    }),
    prisma.mentorshipRelation.count({
      where: { status: 'COMPLETED', completedAt: { gte: since } },
    }),
    prisma.mentorshipRequest.groupBy({
      by: ['rematchReason'],
      where: { rematchReason: { not: null }, createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  // Re-matches first, then oldest-first inside each group (the queue's existing
  // order). Done here rather than in `orderBy` because "rows with a non-null
  // column first" is not expressible without relying on how MySQL sorts NULLs.
  const sorted = [...requests].sort((a, b) => {
    const rank = Number(!!b.replacesRelationId) - Number(!!a.replacesRelationId);
    return rank !== 0 ? rank : a.createdAt.getTime() - b.createdAt.getTime();
  });

  return NextResponse.json({
    requests: sorted,
    rematchStats: {
      days: REMATCH_STATS_DAYS,
      rematched,
      // Everything that ended in the window, re-matches included — the
      // denominator of the rate the admin sees.
      ended: endedTotal,
      byReason: Object.fromEntries(
        byReason.map((row) => [row.rematchReason as string, row._count._all])
      ),
    },
  });
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
