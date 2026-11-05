import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { logActivity } from '@/lib/activity';
import { requireCompanySeat } from '@/lib/companySeatGate';
import { isSeatRole, type SeatRole } from '@/lib/companySeats';
import { changeSeatRole, removeTeammate } from '@/lib/companyTeam';

// /api/company/team/[userId] (#1870) — an OWNER seat changes a teammate's seat
// (PATCH) or removes them (DELETE). Another company's member answers 404, the
// same as an id that does not exist. Leaving the company without an OWNER is
// refused (`409 last_owner`), and so is removing oneself (`400 not_yourself`).
// Both writes are audited with the org passed explicitly.

const patchSchema = z.object({ seatRole: z.string().refine(isSeatRole, 'unknown seatRole') }).strict();
const REFUSAL_STATUS = { seat_limit_reached: 403, email_taken: 409, invitation_pending: 409, not_found: 404, last_owner: 409, not_yourself: 400 } as const;

async function ownerScope() {
  const session = await getServerSession(authOptions);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return { error: capGate };
  if (session.user.role !== 'COMPANY') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  const companyId = session.user.companyId;
  const orgId = resolveOrgId(session);
  if (!companyId || !orgId) return { error: NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 }) };
  const seatGate = await requireCompanySeat(session, 'team.manage');
  if (seatGate) return { error: seatGate };
  return { session, companyId, orgId };
}

async function audit(orgId: string, actorId: string, action: string, targetId: string, detail: Record<string, unknown>, request: Request) {
  await prisma.auditLog.create({ data: { orgId, actorId, action, targetId, detail: JSON.stringify(detail) } });
  await logActivity({ action: action.toLowerCase(), actorId, targetType: 'user', targetId, detail: JSON.stringify(detail), request });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const scope = await ownerScope();
  if ('error' in scope) return scope.error;
  const { userId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'validation_failed' }, { status: 400 });
  const seatRole = parsed.data.seatRole as SeatRole;
  return withTenantScope(scope.session, async () => {
    const result = await changeSeatRole({ orgId: scope.orgId, companyId: scope.companyId, userId, seatRole });
    if (!result.ok) return NextResponse.json({ error: 'Change refused', ...result.refusal }, { status: REFUSAL_STATUS[result.refusal.code] });
    await audit(scope.orgId, scope.session.user.id, 'COMPANY_SEAT_ROLE', userId, { companyId: scope.companyId, seatRole }, request);
    return NextResponse.json({ ok: true, seatRole });
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const scope = await ownerScope();
  if ('error' in scope) return scope.error;
  const { userId } = await params;
  return withTenantScope(scope.session, async () => {
    const result = await removeTeammate({ orgId: scope.orgId, companyId: scope.companyId, userId, actorId: scope.session.user.id });
    if (!result.ok) return NextResponse.json({ error: 'Removal refused', ...result.refusal }, { status: REFUSAL_STATUS[result.refusal.code] });
    await audit(scope.orgId, scope.session.user.id, 'COMPANY_SEAT_REMOVED', userId, { companyId: scope.companyId }, request);
    return NextResponse.json({ ok: true });
  });
}
