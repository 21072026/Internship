import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { dispatchWebhook } from '@/lib/webhooks';
import { withTenantScope } from '@/lib/orgContext';

const updateRelationSchema = z.object({
  status: z.enum(['ACTIVE', 'COMPLETED']).optional(),
  // Stage key is a free string now (#747) so tenants can use their own stages;
  // the UI only offers the tenant's resolved stages. Bounded to the PipelineStage
  // key constraint.
  pipelineStatus: z.string().min(1).max(60).optional(),
  companyId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  cohortId: z.string().nullable().optional(),
  stageDeadline: z.string().nullable().optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const relation = await prisma.mentorshipRelation.findUnique({
        where: { id },
        include: {
          mentor: { select: { id: true, fullName: true, email: true, department: true } },
          mentee: {
            select: {
              id: true,
              fullName: true,
              email: true,
              university: true,
              graduationYear: true,
              skills: true,
              phone: true,
              whatsapp: true,
              city: true,
              birthDate: true,
              referralSource: true,
              cvUrl: true,
            },
          },
          company: true,
          interactions: { orderBy: { date: 'desc' } },
          statusChanges: {
            orderBy: { createdAt: 'desc' },
            include: { changedBy: { select: { fullName: true } } },
          },
        },
      });

      if (!relation) {
        return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
      }

      const isAuthorized =
        session.user.role === 'ADMIN' ||
        relation.mentorId === session.user.id ||
        relation.menteeId === session.user.id;

      if (!isAuthorized) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      // Surface the linked company's shortlist signal (EPIC: company shortlist)
      // to the mentor/admin viewing this relation.
      const companyInterest = relation.companyId
        ? await prisma.companyInterest.findUnique({
            where: { companyId_menteeId: { companyId: relation.companyId, menteeId: relation.menteeId } },
          })
        : null;

      return NextResponse.json({ relation: { ...relation, companyInterest } });
    });
  } catch (error) {
    console.error('Get mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const relation = await prisma.mentorshipRelation.findUnique({
        where: { id },
      });

      if (!relation) {
        return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
      }

      const isAuthorized =
        session.user.role === 'ADMIN' || relation.mentorId === session.user.id;

      if (!isAuthorized) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const body = await request.json();
      const parsed = updateRelationSchema.safeParse(body);

      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: parsed.error.flatten() },
          { status: 400 }
        );
      }

      const { stageDeadline, ...rest } = parsed.data;
      const data: Prisma.MentorshipRelationUncheckedUpdateInput = { ...rest };
      if (stageDeadline !== undefined) {
        data.stageDeadline = stageDeadline ? new Date(stageDeadline) : null;
        // A fresh deadline (or cleared) re-arms the overdue reminder.
        data.deadlineReminderSentAt = null;
      }

      const updated = await prisma.mentorshipRelation.update({
        where: { id },
        data,
        include: {
          mentor: { select: { id: true, fullName: true, email: true } },
          mentee: { select: { id: true, fullName: true, email: true } },
          company: { select: { id: true, name: true } },
        },
      });

      // Record an audit entry when the pipeline stage actually changes.
      if (parsed.data.pipelineStatus && parsed.data.pipelineStatus !== relation.pipelineStatus) {
        await prisma.statusChange.create({
          data: {
            relationId: id,
            fromStatus: relation.pipelineStatus,
            toStatus: parsed.data.pipelineStatus,
            changedById: session.user.id,
          },
        });
        await logActivity({
          action: 'pipeline.stage_change',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'relation',
          targetId: id,
          detail: `${relation.pipelineStatus} → ${parsed.data.pipelineStatus}`,
        });
        await notify(relation.menteeId, 'stage', 'Your pipeline stage was updated.', '/portal');
        await dispatchWebhook('pipeline.stage_change', { relationId: id, from: relation.pipelineStatus, to: parsed.data.pipelineStatus });
      }

      return NextResponse.json({ relation: updated });
    });
  } catch (error) {
    console.error('Update mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
