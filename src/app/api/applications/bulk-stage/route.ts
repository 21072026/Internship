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
import { actorFlagsFor, moveApplicationStage, visibleApplicationsWhere } from '@/lib/applicationStage';

export const BULK_STAGE_MAX_IDS = 50;

const bodySchema = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).min(1).max(BULK_STAGE_MAX_IDS),
  toStage: z.string().trim().min(1).max(32),
  note: z.string().trim().max(1000).optional(),
  dispositionCode: z.string().trim().max(32).optional(),
}).strict();

const ACTING_ROLES = ['ADMIN', 'MENTOR', 'MENTEE', 'COMPANY'];

export type BulkSkipReason = 'not_found' | 'invalid_transition' | 'forbidden' | 'stage_conflict' | 'disposition_required' | 'illegal_transition';

// POST — move up to 50 applications to one stage (#1836), the same rules as the
// single route applied per row from each row's CURRENT stage. Partial success
// is reported honestly: `moved` holds only ids whose guarded write changed a
// row, every other id is in `skipped` with its reason, and nothing is ever
// claimed moved that was not (the lesson of /api/admin/company-users).
export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Placement write (#2364).
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const role = session.user.role;
    if (!ACTING_ROLES.includes(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const { ids, toStage, note, dispositionCode } = parsed.data;
    if (!isApplicationStage(toStage)) return NextResponse.json({ error: 'Unknown stage', code: 'unknown_stage' }, { status: 400 });
    if (requiresDispositionCode(toStage) && (!dispositionCode || !isDispositionCode(dispositionCode))) {
      return NextResponse.json({ error: 'A valid dispositionCode is required', code: 'disposition_required' }, { status: 400 });
    }
    const code = requiresDispositionCode(toStage) && dispositionCode && isDispositionCode(dispositionCode) ? dispositionCode : null;
    const actor = { id: session.user.id, role, orgId, companyId: session.user.companyId ?? null };
    const scope = visibleApplicationsWhere(actor);
    if (!scope) return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
    const uniqueIds = [...new Set(ids)];

    return withTenantScope(session, async () => {
      const rows = await prisma.application.findMany({
        where: { id: { in: uniqueIds }, ...scope },
        select: { id: true, stage: true, menteeId: true, requisition: { select: { companyId: true } } },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const moved: string[] = [];
      const skipped: { id: string; reason: BulkSkipReason }[] = [];
      for (const id of uniqueIds) {
        const row = byId.get(id);
        if (!row) { skipped.push({ id, reason: 'not_found' }); continue; }
        if (!canTransition(row.stage, toStage)) { skipped.push({ id, reason: 'invalid_transition' }); continue; }
        if (!canPerformApplicationAction({ ...actorFlagsFor(actor, row), from: row.stage, to: toStage })) {
          skipped.push({ id, reason: 'forbidden' });
          continue;
        }
        // One transaction per row: a conflict on one id must not roll back the
        // moves that succeeded before it.
        const result = await prisma.$transaction((tx) =>
          moveApplicationStage(tx, { applicationId: id, expectedStage: row.stage, toStage, actorId: session.user.id, note, dispositionCode: code }),
        );
        if (!result.ok) { skipped.push({ id, reason: result.reason }); continue; }
        await logActivity({
          action: 'application.stage.set',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'application',
          targetId: id,
          detail: `${result.fromStage} -> ${result.toStage}${code ? `; reason=${code}` : ''}; bulk`,
          request,
          orgId,
        });
        moved.push(id);
      }
      return NextResponse.json({ moved, skipped });
    });
  });
}
