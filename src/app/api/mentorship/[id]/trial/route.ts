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
import { emitStageChange } from '@/lib/stageChangeEffects';
import { statusChangeData } from '@/lib/stageChange';
import { trialActiveStageKey } from '@/lib/trialReminders';
import { parseTrialEndDate, planTrialEndChange } from '@/lib/trialReminderRule';

// PATCH /api/mentorship/<id>/trial — set or extend a funnel record's trial end
// (#2553, story #2392).
//
// Its own endpoint, not one more optional field on PUT /api/mentorship/[id]:
// the stage writes there stamp a trial window only when none exists and never
// move one (trialWindowFor(), #2551 — a board drag must not extend a trial),
// whereas this write exists precisely to move it, and it can move the stage
// with it. Keeping the two apart keeps both rules readable.
//
// WHO: an ADMIN of the record's tenant, or the record's owner (`mentorId` — what
// the MARKETING overlay calls the owner). Everyone else is 403, including the
// lead on the record, who reads the relation but is never its owner.
//
// WHAT IT WRITES, and what it deliberately does not:
//   * `trialEndsAt`, as the UTC day typed (planTrialEndChange() decides what is
//     allowed: a trial stage, today or later, and a real change);
//   * for a record in TRIAL_EXPIRED, the stage back to TRIAL_ACTIVE — a HUMAN
//     move, so it gets its StatusChange row and emitStageChange() like any board
//     move (#2451's never-move-back rule binds the machine writers only);
//   * NOT the `TrialReminder` claim rows. They are kept on purpose, so a mark
//     that was mailed is never mailed again, and the marks the new window still
//     has ahead of it fire on their day (see the rule's header);
//   * NOT `trialStartedAt`. A start nobody recorded is not invented here either.
//
// AUDIT: the date change is an ActivityLog entry (`trial.end_changed`, old →
// new day) — a field edit, not a stage move, so it is not a StatusChange.

const bodySchema = z.object({
  // `YYYY-MM-DD`. Loose here on purpose; the shape rule is parseTrialEndDate().
  trialEndsAt: z.string().max(20),
});

function isoDay(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : 'none';
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    try {
      const { id } = await params;
      const session = await getServerSession(authOptions);
      if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const denied = await requireCapability(session.user.orgId ?? null, 'pipeline');
      if (denied) return denied;

      return await withTenantScope(session, async () => {
        // By-id through the tenant filter (#2542): with isolation enforcement
        // off, another tenant's record id must read as "not found".
        const relation = await prisma.mentorshipRelation.findFirst({
          where: withinTenant({ id }, await tenantWhere(session)),
          select: {
            id: true,
            orgId: true,
            status: true,
            mentorId: true,
            menteeId: true,
            pipelineStatus: true,
            trialEndsAt: true,
          },
        });
        if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });

        const isOwner = relation.mentorId === session.user.id;
        if (session.user.role !== 'ADMIN' && !isOwner) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body: unknown = await request.json().catch(() => null);
        const parsed = bodySchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
        }

        if (relation.status !== 'ACTIVE') {
          return NextResponse.json({ error: 'The record is closed', code: 'relation_closed' }, { status: 409 });
        }

        const now = new Date();
        const plan = planTrialEndChange({
          pipelineStatus: relation.pipelineStatus,
          currentEndsAt: relation.trialEndsAt,
          newEndsAt: parseTrialEndDate(parsed.data.trialEndsAt),
          now,
        });
        if (!plan.ok) {
          const status = plan.error === 'not_in_trial' ? 409 : 400;
          return NextResponse.json({ error: 'Cannot set the trial end', code: plan.error }, { status });
        }
        if (!plan.changed) {
          return NextResponse.json({
            relation: { id: relation.id, pipelineStatus: relation.pipelineStatus, trialEndsAt: relation.trialEndsAt },
            changed: false,
            reopened: false,
          });
        }

        // The stage the record returns to, resolved through the tenant's own
        // stages: a tenant without a TRIAL_ACTIVE stage gets the date and keeps
        // its stage rather than being moved into a key it does not have.
        const reopenTo = plan.reopen ? await trialActiveStageKey(relation.orgId) : null;

        // Conditional on the stage AND the end date we planned against, so a
        // sweep, a board move or a second concurrent PATCH in between cannot be
        // overwritten with a stale plan (and the audit's "old" day stays true).
        const written = await prisma.mentorshipRelation.updateMany({
          where: { id: relation.id, pipelineStatus: relation.pipelineStatus, trialEndsAt: relation.trialEndsAt },
          data: { trialEndsAt: plan.trialEndsAt, ...(reopenTo ? { pipelineStatus: reopenTo } : {}) },
        });
        if (written.count === 0) {
          return NextResponse.json({ error: 'The record changed meanwhile, reload it', code: 'conflict' }, { status: 409 });
        }

        await logActivity({
          action: 'trial.end_changed',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'relation',
          targetId: relation.id,
          detail: `${isoDay(relation.trialEndsAt)} → ${isoDay(plan.trialEndsAt)}`,
          request,
        });

        const auditRow = reopenTo
          ? statusChangeData({
              relationId: relation.id,
              fromStatus: relation.pipelineStatus,
              toStatus: reopenTo,
              changedById: session.user.id,
            })
          : null;
        if (reopenTo && auditRow) {
          await prisma.statusChange.create({ data: auditRow });
          await logActivity({
            action: 'pipeline.stage_change',
            actorId: session.user.id,
            actorEmail: session.user.email ?? null,
            targetType: 'relation',
            targetId: relation.id,
            detail: `${relation.pipelineStatus} → ${reopenTo}`,
            request,
          });
          await emitStageChange({
            relationId: relation.id,
            menteeId: relation.menteeId,
            orgId: relation.orgId,
            from: relation.pipelineStatus,
            to: reopenTo,
          });
        }

        return NextResponse.json({
          relation: {
            id: relation.id,
            pipelineStatus: reopenTo ?? relation.pipelineStatus,
            trialEndsAt: plan.trialEndsAt,
          },
          changed: true,
          reopened: !!reopenTo,
        });
      });
    } catch (error) {
      console.error('Trial end update error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
