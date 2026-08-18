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
import { isPendingActivation } from '@/lib/menteeAccount';
import { validateDropoffReason } from '@/lib/stageChange';
import { PIPELINE_STATUSES } from '@/lib/pipeline';
import { resolvePipelineStages } from '@/lib/pipelineStages';

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
  // Drop-off reason (#810) — required by validateDropoffReason() below when
  // pipelineStatus moves into a negative/off-path stage. z.string() + a
  // central whitelist (src/lib/dropoffReasons.ts), never z.enum.
  reasonCode: z.string().max(40).optional(),
  reasonNote: z.string().max(2000).optional(),
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
              // Only to derive `pendingActivation` below — destructured out
              // before the response so the column never reaches a client.
              password: true,
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
        ? await prisma.companyInterest.findFirst({
            where: { companyId: relation.companyId, menteeId: relation.menteeId, requisitionId: null },
          })
        : null;

      // A mentee the mentor typed in has a sentinel where the hash goes and can
      // never sign in; the detail page offers to fix the address and send the
      // activation link (#1123). The sentinel itself stays server-side.
      const { password: menteePassword, ...mentee } = relation.mentee;

      return NextResponse.json({
        relation: {
          ...relation,
          mentee: { ...mentee, pendingActivation: isPendingActivation({ password: menteePassword }) },
          companyInterest,
        },
      });
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

      const { stageDeadline, reasonCode, reasonNote, ...rest } = parsed.data;
      const stageChanging = !!parsed.data.pipelineStatus && parsed.data.pipelineStatus !== relation.pipelineStatus;

      // Validate the drop-off reason BEFORE writing anything — a rejected
      // reason must never leave the relation moved with no audit trail behind it.
      if (stageChanging) {
        const reasonCheck = await validateDropoffReason({
          orgId: relation.orgId,
          toStatus: parsed.data.pipelineStatus!,
          reasonCode,
          reasonNote,
        });
        if (!reasonCheck.ok) {
          return NextResponse.json({ error: reasonCheck.error }, { status: 400 });
        }
      }

      const data: Prisma.MentorshipRelationUncheckedUpdateInput = { ...rest };
      // Stamp/clear the end of the relation — it anchors the post-mentorship
      // CV/document access window (#854).
      if (parsed.data.status && parsed.data.status !== relation.status) {
        data.completedAt = parsed.data.status === 'COMPLETED' ? new Date() : null;
      }
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
      if (stageChanging) {
        await prisma.statusChange.create({
          data: {
            relationId: id,
            fromStatus: relation.pipelineStatus,
            toStatus: parsed.data.pipelineStatus!,
            changedById: session.user.id,
            reasonCode: reasonCode ?? null,
            reasonNote: reasonNote?.trim() || null,
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
        // The notification stores stage KEYS; the renderer localizes built-in
        // stages at display time. Custom (per-org) stage keys have no dictionary
        // label, so snapshot their tenant-set labels into the params (#921).
        // `relation` still holds the pre-update row, so this is the old status.
        const fromStatus = relation.pipelineStatus;
        const toStatus = parsed.data.pipelineStatus!;
        const stageParams: Record<string, string> = { from: fromStatus, to: toStatus };
        const builtIn = PIPELINE_STATUSES as readonly string[];
        if (!builtIn.includes(fromStatus) || !builtIn.includes(toStatus)) {
          const stages = await resolvePipelineStages(relation.orgId);
          if (!builtIn.includes(fromStatus)) {
            const label = stages.find((s) => s.key === fromStatus)?.label;
            if (label) stageParams.fromLabel = label;
          }
          if (!builtIn.includes(toStatus)) {
            const label = stages.find((s) => s.key === toStatus)?.label;
            if (label) stageParams.toLabel = label;
          }
        }
        await notify(relation.menteeId, 'stage.changed', stageParams, '/portal');
        await dispatchWebhook('pipeline.stage_change', { relationId: id, from: relation.pipelineStatus, to: parsed.data.pipelineStatus });
      }

      return NextResponse.json({ relation: updated });
    });
  } catch (error) {
    console.error('Update mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
