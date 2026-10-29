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
import {
  canPerformApplicationAction,
  canTransition,
  isApplicationStage,
  isDispositionCode,
  requiresDispositionCode,
} from '@/lib/applications';
import { APPLICATION_SELECT, actorFlagsFor, moveApplicationStage, visibleApplicationsWhere } from '@/lib/applicationStage';
import { stageTransaction } from '@/lib/applicationStageEvents';

const bodySchema = z.object({
  toStage: z.string().trim().min(1).max(32),
  /** The stage the client is looking at — a stale one answers 409, never a lost update. */
  expectedStage: z.string().trim().min(1).max(32),
  note: z.string().trim().max(1000).optional(),
  dispositionCode: z.string().trim().max(32).optional(),
}).strict();

const ACTING_ROLES = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY'];

// PATCH — move one application to the next stage (#1836): who may move what is
// canPerformApplicationAction() with flags read from the database, the legal
// path is canTransition(), a move to REJECTED needs a dispositionCode, and the
// write is a guarded updateMany so two concurrent moves produce one success and
// one 409 stage_conflict. Writes exactly one ApplicationEvent and one activity row.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Placement write (#2364): the funnel is part of the placements module.
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const role = session.user.role;
    if (!ACTING_ROLES.includes(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const { toStage, expectedStage, note, dispositionCode } = parsed.data;
    if (!isApplicationStage(toStage) || !isApplicationStage(expectedStage)) {
      return NextResponse.json({ error: 'Unknown stage', code: 'unknown_stage' }, { status: 400 });
    }
    const { id } = await params;
    const actor = { id: session.user.id, role, orgId, companyId: session.user.companyId ?? null };
    const scope = visibleApplicationsWhere(actor);
    if (!scope) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });

    return withTenantScope(session, async () => {
      const current = await prisma.application.findFirst({
        where: { id, ...scope },
        select: { id: true, stage: true, menteeId: true, requisitionId: true, requisition: { select: { companyId: true } } },
      });
      if (!current) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      if (current.stage !== expectedStage) {
        return NextResponse.json({ error: 'The application moved meanwhile', code: 'stage_conflict', stage: current.stage }, { status: 409 });
      }
      if (!canTransition(expectedStage, toStage)) {
        return NextResponse.json({ error: `Cannot move from ${expectedStage} to ${toStage}`, code: 'invalid_transition' }, { status: 400 });
      }
      if (!canPerformApplicationAction({ ...actorFlagsFor(actor, current), from: expectedStage, to: toStage })) {
        return NextResponse.json({ error: 'Forbidden', code: 'forbidden_transition' }, { status: 403 });
      }
      if (requiresDispositionCode(toStage) && (!dispositionCode || !isDispositionCode(dispositionCode))) {
        return NextResponse.json({ error: 'A valid dispositionCode is required', code: 'disposition_required' }, { status: 400 });
      }
      const code = requiresDispositionCode(toStage) && dispositionCode && isDispositionCode(dispositionCode) ? dispositionCode : null;

      const result = await stageTransaction((tx) =>
        moveApplicationStage(tx, { applicationId: current.id, expectedStage, toStage, actorId: session.user.id, note, dispositionCode: code }),
      );
      if (!result.ok) {
        if (result.reason === 'stage_conflict') {
          return NextResponse.json({ error: 'The application moved meanwhile', code: 'stage_conflict' }, { status: 409 });
        }
        return NextResponse.json({ error: 'Invalid transition', code: result.reason }, { status: 400 });
      }

      await logActivity({
        action: 'application.stage.set',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'application',
        targetId: current.id,
        detail: `${result.fromStage} -> ${result.toStage}${code ? `; reason=${code}` : ''}`,
        request,
        orgId,
      });

      const updated = await prisma.application.findUniqueOrThrow({ where: { id: current.id }, select: APPLICATION_SELECT });
      // A reason is about the candidate and is not read back to them (#1801).
      const application = role === 'MENTEE' ? { ...updated, dispositionCode: null } : updated;
      return NextResponse.json({ application });
    });
  });
}
