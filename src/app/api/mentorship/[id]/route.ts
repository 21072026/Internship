import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { emitStageChange } from '@/lib/stageChangeEffects';
import { withTenantScope } from '@/lib/orgContext';
import { isPendingActivation } from '@/lib/menteeAccount';
import { validateDropoffReason } from '@/lib/stageChange';

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
              // The merged referrer (#1296): the person or the source who
              // brought this mentee in, plus the legacy free text for records
              // typed before the merge.
              referralSource: true,
              referredBy: { select: { fullName: true } },
              source: { select: { name: true } },
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
        // Notification + webhook via the shared effects service (#926) so every
        // stage-write path emits identically. `relation` still holds the
        // pre-update row, so this is the old status.
        await emitStageChange({
          relationId: id,
          menteeId: relation.menteeId,
          orgId: relation.orgId,
          from: relation.pipelineStatus,
          to: parsed.data.pipelineStatus!,
          reasonCode,
        });
      }

      return NextResponse.json({ relation: updated });
    });
  } catch (error) {
    console.error('Update mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
