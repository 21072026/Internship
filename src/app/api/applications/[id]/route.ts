import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { canPerformApplicationAction } from '@/lib/applications';
import { APPLICATION_SELECT, actorFlagsFor, moveApplicationStage, visibleApplicationsWhere } from '@/lib/applicationStage';

const bodySchema = z.object({ action: z.literal('withdraw') }).strict();

// PATCH { action: 'withdraw' } — the one thing a mentee does to their own
// application (#1832). It is canPerformApplicationAction()'s MENTEE rule and
// moveApplicationStage() — the one writer — so it stamps withdrawnAt, writes
// the ApplicationEvent and loses a race with a 409, exactly like the stage
// route. Withdrawn is terminal: the mentee cannot undo it. Not yours is a 404.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const actor = { id: session.user.id, role: session.user.role, orgId, companyId: session.user.companyId ?? null };
    const scope = visibleApplicationsWhere(actor);
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { id } = await params;

    return withTenantScope(session, async () => {
      const current = await prisma.application.findFirst({ where: { id, ...scope }, select: { id: true, stage: true, menteeId: true, requisition: { select: { companyId: true } } } });
      if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!canPerformApplicationAction({ ...actorFlagsFor(actor, current), from: current.stage, to: 'WITHDRAWN' })) {
        return NextResponse.json({ error: 'This application cannot be withdrawn', code: 'cannot_withdraw' }, { status: 409 });
      }
      const result = await prisma.$transaction((tx) =>
        moveApplicationStage(tx, { applicationId: current.id, expectedStage: current.stage, toStage: 'WITHDRAWN', actorId: session.user.id }),
      );
      if (!result.ok) return NextResponse.json({ error: 'The application moved meanwhile', code: 'stage_conflict' }, { status: 409 });
      await logActivity({ action: 'application.stage.set', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'application', targetId: current.id, detail: `${result.fromStage} -> WITHDRAWN; withdraw`, request, orgId });
      const updated = await prisma.application.findUniqueOrThrow({ where: { id: current.id }, select: APPLICATION_SELECT });
      return NextResponse.json({ application: session.user.role === 'MENTEE' ? { ...updated, dispositionCode: null } : updated });
    });
  });
}
