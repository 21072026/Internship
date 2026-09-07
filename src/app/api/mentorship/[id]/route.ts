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
import { isStageTransition, statusChangeData, validateDropoffReason } from '@/lib/stageChange';
import {
  findActiveMentorship,
  hasOtherActiveMentorship,
  ALREADY_MENTORED_ERROR,
  AlreadyMentoredError,
} from '@/lib/activeMentorship';

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
              // Only to derive `stageClockPaused` below — destructured out
              // before the response, like `password` above (#1724).
              reEngageAt: true,
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
      const { password: menteePassword, reEngageAt, ...mentee } = relation.mentee;

      // The re-engagement pool (#834) reaching the stage clock in the header:
      // somebody agreed a "we'll write in September" date with this mentee, so
      // the chip shows the days but never a breach — the same people the admin
      // aging report keeps out of its overdue list. Only the boolean ships, and
      // only to the roles that can already list the pool (GET /api/re-engagement).
      const seesPool = session.user.role === 'ADMIN' || session.user.role === 'MENTOR';

      return NextResponse.json({
        relation: {
          ...relation,
          statusChanges: relation.statusChanges.filter((change) =>
            isStageTransition(change.fromStatus, change.toStatus)
          ),
          mentee: { ...mentee, pendingActivation: isPendingActivation({ password: menteePassword }) },
          companyInterest,
          ...(seesPool ? { stageClockPaused: reEngageAt != null } : {}),
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

      const { stageDeadline, reasonCode, reasonNote, pipelineStatus, ...rest } = parsed.data;
      const stageChanging = !!pipelineStatus && isStageTransition(relation.pipelineStatus, pipelineStatus);

      // Validate the drop-off reason BEFORE writing anything — a rejected
      // reason must never leave the relation moved with no audit trail behind it.
      if (stageChanging) {
        const reasonCheck = await validateDropoffReason({
          orgId: relation.orgId,
          toStatus: pipelineStatus!,
          reasonCode,
          reasonNote,
        });
        if (!reasonCheck.ok) {
          return NextResponse.json({ error: reasonCheck.error }, { status: 400 });
        }
      }

      // Back door (#419): reopening a COMPLETED relation to ACTIVE is a second
      // assignment by another name, so it owes the same 409 POST /api/mentorship
      // answers. `exceptRelationId` because this relation is itself part of the
      // comparison. Checked before anything is written — clearing `completedAt`
      // below also silently reopens the post-mentorship document window (#854).
      if (parsed.data.status === 'ACTIVE' && relation.status !== 'ACTIVE') {
        if (await hasOtherActiveMentorship(prisma, relation.menteeId, { exceptRelationId: id })) {
          return NextResponse.json(ALREADY_MENTORED_ERROR, { status: 409 });
        }
      }

      const data: Prisma.MentorshipRelationUncheckedUpdateInput = {
        ...rest,
        ...(stageChanging ? { pipelineStatus } : {}),
      };
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

      // A stage-only request that selects the current value is a successful
      // no-op. Avoid issuing an empty UPDATE while keeping existing clients'
      // `res.ok` contract intact.
      if (Object.keys(data).length === 0) {
        return NextResponse.json({ relation, changed: false });
      }

      // Guard + write in one transaction, mirroring the two front doors: a
      // reopen must not slip past a mentor assigned in between.
      let updated;
      try {
        updated = await prisma.$transaction(async (tx) => {
          if (parsed.data.status === 'ACTIVE' && relation.status !== 'ACTIVE') {
            const active = await findActiveMentorship(tx, relation.menteeId, { exceptRelationId: id });
            if (active) throw new AlreadyMentoredError(relation.menteeId, active.id);
          }
          return tx.mentorshipRelation.update({
            where: { id },
            data,
            include: {
              mentor: { select: { id: true, fullName: true, email: true } },
              mentee: { select: { id: true, fullName: true, email: true } },
              company: { select: { id: true, name: true } },
            },
          });
        });
      } catch (e) {
        if (e instanceof AlreadyMentoredError) {
          return NextResponse.json(ALREADY_MENTORED_ERROR, { status: 409 });
        }
        throw e;
      }

      // Record an audit entry when the pipeline stage actually changes. The row
      // is built by the shared gate (#934), which is what refuses a from === to
      // entry — `stageChanging` already excludes that case, so this is the same
      // rule expressed once instead of per write path.
      const auditRow = stageChanging
        ? statusChangeData({
            relationId: id,
            fromStatus: relation.pipelineStatus,
            toStatus: pipelineStatus!,
            changedById: session.user.id,
            reasonCode,
            reasonNote,
          })
        : null;
      if (auditRow) {
        await prisma.statusChange.create({ data: auditRow });
        await logActivity({
          action: 'pipeline.stage_change',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'relation',
          targetId: id,
          detail: `${relation.pipelineStatus} → ${pipelineStatus}`,
        });
        // Notification + webhook via the shared effects service (#926) so every
        // stage-write path emits identically. `relation` still holds the
        // pre-update row, so this is the old status.
        await emitStageChange({
          relationId: id,
          menteeId: relation.menteeId,
          orgId: relation.orgId,
          from: relation.pipelineStatus,
          to: pipelineStatus!,
          reasonCode,
          // The same request set a deadline by hand — don't overwrite it with
          // the stage's default (#817).
          deadlineSetByCaller: stageDeadline !== undefined,
        });
      }

      return NextResponse.json({ relation: updated });
    });
  } catch (error) {
    console.error('Update mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
