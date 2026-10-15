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
import { parseContractEndDate, planContractEndChange } from '@/lib/contractEndRule';

// PATCH /api/mentorship/<id>/contract-end — a won customer gave notice, or
// withdrew it (#2841). Body: `{ contractEndsAt:
// 'YYYY-MM-DD' }` to set the day the contract ends, `{ contractEndsAt: null }`
// to clear it.
//
// WHO: an ADMIN of the record's tenant, or the record's owner — the same door
// as the trial end (PATCH …/trial). Everyone else is 403.
//
// WHAT IT WRITES: the date (and clears the end-day bell's claim with it, so a
// moved date rings on its new day). It NEVER moves the stage: the customer
// pays until the end, so the record stays DEAL_WON; DEAL_LOST is a human's
// move. AUDIT: an ActivityLog entry, `contract.end_changed`.

const bodySchema = z.object({ contractEndsAt: z.string().max(20).nullable() });

function isoDay(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : 'none';
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const denied = await requireCapability(session.user.orgId ?? null, 'pipeline');
    if (denied) return denied;

    return withTenantScope(session, async () => {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: withinTenant({ id }, await tenantWhere(session)),
        select: { id: true, status: true, mentorId: true, pipelineStatus: true, contractEndsAt: true },
      });
      if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });
      if (session.user.role !== 'ADMIN' && relation.mentorId !== session.user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_date' }, { status: 400 });
      if (relation.status !== 'ACTIVE') {
        return NextResponse.json({ error: 'The record is closed', code: 'relation_closed' }, { status: 409 });
      }

      const raw = parsed.data.contractEndsAt;
      const next = raw === null ? null : parseContractEndDate(raw);
      const plan = planContractEndChange({
        pipelineStatus: relation.pipelineStatus,
        current: relation.contractEndsAt,
        next,
        invalid: raw !== null && next === null,
        now: new Date(),
      });
      if (!plan.ok) {
        return NextResponse.json({ error: 'Cannot set the contract end', code: plan.error }, { status: plan.error === 'not_won' ? 409 : 400 });
      }
      if (!plan.changed) return NextResponse.json({ contractEndsAt: relation.contractEndsAt, changed: false });

      // Conditional on the stage and the date we planned against: a stage move
      // or a second save in between must not be overwritten with a stale plan.
      const written = await prisma.mentorshipRelation.updateMany({
        where: { id: relation.id, pipelineStatus: relation.pipelineStatus, contractEndsAt: relation.contractEndsAt },
        data: { contractEndsAt: plan.contractEndsAt, contractEndRemindedAt: null },
      });
      if (written.count === 0) {
        return NextResponse.json({ error: 'The record changed meanwhile, reload it', code: 'conflict' }, { status: 409 });
      }

      await logActivity({
        action: 'contract.end_changed',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'relation',
        targetId: relation.id,
        detail: `${isoDay(relation.contractEndsAt)} → ${isoDay(plan.contractEndsAt)}`,
        request,
      });
      return NextResponse.json({ contractEndsAt: plan.contractEndsAt, changed: true });
    });
  });
}
