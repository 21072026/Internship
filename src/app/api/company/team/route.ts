import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireCompanySeat, seatRoleOf } from '@/lib/companySeatGate';
import { isSeatRole } from '@/lib/companySeats';
import { inviteTeammate, loadTeam } from '@/lib/companyTeam';
import { TEXT_LIMITS } from '@/lib/textLimits';

// /api/company/team (#1870, docs/company-team-seats.md) — the COMPANY user's
// own team. Anyone with a seat may see who else has one; only an OWNER seat
// invites (requireCompanySeat 'team.manage'). The invitation token is mailed,
// never returned. Over `Company.quota` the answer is `403 seat_limit_reached`
// with `limit` and `used`, the shape the upgrade prompt reads (#1745).

async function companyScope() {
  const session = await getServerSession(authOptions);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return { error: capGate };
  if (session.user.role !== 'COMPANY') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  const companyId = session.user.companyId;
  const orgId = resolveOrgId(session);
  if (!companyId || !orgId) return { error: NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 }) };
  return { session, companyId, orgId };
}

export async function GET() {
  const scope = await companyScope();
  if ('error' in scope) return scope.error;
  return withTenantScope(scope.session, async () => {
    const team = await loadTeam(scope.orgId, scope.companyId);
    const mySeat = await seatRoleOf(scope.session.user.id, scope.companyId);
    return NextResponse.json({ ...team, mySeat, me: scope.session.user.id });
  });
}

const inviteSchema = z
  .object({
    email: z.string().trim().email().max(TEXT_LIMITS.companyContactEmail),
    seatRole: z.string().refine(isSeatRole, 'unknown seatRole'),
    locale: z.string().max(5).optional(),
  })
  .strict();

const REFUSAL_STATUS = { seat_limit_reached: 403, email_taken: 409, invitation_pending: 409, not_found: 404, last_owner: 409, not_yourself: 400 } as const;

export async function POST(request: Request) {
  const scope = await companyScope();
  if ('error' in scope) return scope.error;
  const seatGate = await requireCompanySeat(scope.session, 'team.manage');
  if (seatGate) return seatGate;
  const limited = enforceRateLimit(request, 'company-team-invite', { limit: 20, windowMs: 60 * 60 * 1000, subject: scope.session.user.id });
  if (limited) return limited;
  const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'validation_failed', details: parsed.error.flatten() }, { status: 400 });
  return withTenantScope(scope.session, async () => {
    const result = await inviteTeammate({
      orgId: scope.orgId,
      companyId: scope.companyId,
      actor: { id: scope.session.user.id, email: scope.session.user.email ?? null },
      email: parsed.data.email,
      seatRole: parsed.data.seatRole as Parameters<typeof inviteTeammate>[0]['seatRole'],
      locale: parsed.data.locale ?? null,
      request,
    });
    if (!result.ok) {
      return NextResponse.json({ error: 'Invitation refused', ...result.refusal }, { status: REFUSAL_STATUS[result.refusal.code] });
    }
    return NextResponse.json({ ok: true, invitationId: result.invitationId, emailSent: result.emailSent }, { status: 201 });
  });
}
