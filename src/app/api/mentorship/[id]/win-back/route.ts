import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { logActivity } from '@/lib/activity';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { AlreadyMentoredError, alreadyMentoredBody } from '@/lib/activeMentorship';
import { planWinBack } from '@/lib/winBackRule';
import { winBack, WinBackConflictError } from '@/lib/winBack';

// POST /api/mentorship/<id>/win-back — a lost customer came back (#2842). Body `{ toStage: 'TRIAL_ACTIVE' | 'DEAL_WON' }`.
// The lost journey closes as COMPLETED + ENDED_CHURNED and a new one opens,
// linked by previousRelationId (src/lib/winBack.ts). WHO: the record's owner
// or an ADMIN of its tenant, like every other edit of a funnel record.

const bodySchema = z.object({ toStage: z.string().max(64) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const denied = await requireCapability(session.user.orgId ?? null, 'pipeline');
    if (denied) return denied;

    return withTenantScope(session, async () => {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: { id: true, orgId: true, status: true, mentorId: true, pipelineStatus: true },
      });
      if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
      if (session.user.role !== 'ADMIN' && relation.mentorId !== session.user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'bad_stage' }, { status: 400 });

      const stages = await resolvePipelineStages(relation.orgId);
      const plan = planWinBack({ relation, toStage: parsed.data.toStage, stageKeys: stages.map((s) => s.key) });
      if (!plan.ok) {
        return NextResponse.json({ error: 'Cannot win this record back', code: plan.error }, { status: plan.error === 'bad_stage' ? 400 : 409 });
      }

      try {
        const { newRelationId } = await winBack({ relationId: relation.id, toStage: plan.toStage, expect: { pipelineStatus: relation.pipelineStatus }, actorId: session.user.id });
        await logActivity({
          action: 'pipeline.win_back',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'relation',
          targetId: newRelationId,
          detail: `${relation.id} (DEAL_LOST, ENDED_CHURNED) → ${plan.toStage}`,
          request,
        });
        return NextResponse.json({ relationId: newRelationId, toStage: plan.toStage }, { status: 201 });
      } catch (e) {
        if (e instanceof WinBackConflictError) {
          return NextResponse.json({ error: 'The record changed meanwhile, reload it', code: 'conflict' }, { status: 409 });
        }
        if (e instanceof AlreadyMentoredError) {
          return NextResponse.json(await alreadyMentoredBody(prisma, e.existingRelationId), { status: 409 });
        }
        throw e;
      }
    });
  });
}
