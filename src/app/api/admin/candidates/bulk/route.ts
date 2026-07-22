import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { nextOnPathStatus, type PipelineStatus } from '@/lib/pipeline';
import { withTenantScope } from '@/lib/orgContext';

const bodySchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['activate', 'deactivate', 'advanceStage']),
});

// POST — bulk activate/deactivate/advanceStage candidates from the admin
// candidates grid (EPIC: HR bulk operations). Scoped to role MENTEE as
// defense in depth — this endpoint can never touch an admin/mentor account
// even if the caller somehow sent the wrong IDs.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { candidateIds, action } = parsed.data;

  if (action === 'activate' || action === 'deactivate') {
    const isActive = action === 'activate';
    const result = await prisma.user.updateMany({
      where: { id: { in: candidateIds }, role: 'MENTEE' },
      data: { isActive },
    });

    await logActivity({
      action: `candidates.bulk.${action}`,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: candidateIds.join(','),
    });

    return NextResponse.json({ ok: true, updated: result.count });
  }

  if (action === 'advanceStage') {
    // Find active relations for these mentees.
    const relations = await prisma.mentorshipRelation.findMany({
      where: { menteeId: { in: candidateIds }, status: 'ACTIVE' },
      select: { id: true, menteeId: true, pipelineStatus: true },
    });

    let advanced = 0;
    for (const rel of relations) {
      // Advance along the happy path only. Off-path/terminal states
      // (EMPLOYED_700, INTERNSHIP_DROPPED_460, INTERNSHIP_FOUND_ELSEWHERE_800)
      // yield null and are skipped, so "advance" never bumps an in-progress
      // internship to "dropped" or an employed mentee to "found elsewhere".
      const nextStatus = nextOnPathStatus(rel.pipelineStatus);
      if (!nextStatus) continue;

      await prisma.$transaction([
        prisma.mentorshipRelation.update({
          where: { id: rel.id },
          data: { pipelineStatus: nextStatus },
        }),
        prisma.statusChange.create({
          data: {
            relationId: rel.id,
            fromStatus: rel.pipelineStatus as PipelineStatus,
            toStatus: nextStatus,
            changedById: session.user.id,
          },
        }),
      ]);
      advanced++;
    }

    await logActivity({
      action: 'candidates.bulk.advanceStage',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: candidateIds.join(','),
    });

    return NextResponse.json({ ok: true, updated: advanced });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  });
}
