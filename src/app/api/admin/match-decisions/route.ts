import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';

// GET /api/admin/match-decisions?relationId=|menteeId= (#1789) — the audit
// trail of pairings: the frozen score and rule rows, the rule set version, who
// decided, whether they overrode the ranking and their note. It is the AI Act
// evidence trail, so it is an AUDIT read (`audit.read`), decided server-side;
// the panel being admin-only is presentation. Tenant-scoped by hand as well as
// by the scope. Paginated, newest first.
const PAGE_MAX = 50;

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('audit.read', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const relationId = params.get('relationId');
    const menteeId = params.get('menteeId');
    if (!relationId && !menteeId) return NextResponse.json({ error: 'relationId or menteeId is required' }, { status: 400 });
    const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(params.get('pageSize') ?? '20', 10) || 20));

    return withTenantScope(session, async () => {
      const where = withinTenant(
        { ...(relationId ? { relationId } : {}), ...(menteeId ? { menteeId } : {}) },
        await tenantWhere(session),
      );
      const [total, rows] = await Promise.all([
        prisma.matchDecision.count({ where }),
        prisma.matchDecision.findMany({ where, orderBy: { decidedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      ]);
      // Names for the bare ids (the row outlives the people it names; a gone
      // person reads as null, never as an error).
      const ids = [...new Set(rows.flatMap((r) => [r.mentorId, r.menteeId, r.decidedById]))];
      const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
      const nameOf = new Map(people.map((p) => [p.id, p.fullName]));
      return NextResponse.json({
        total,
        page,
        pageSize,
        decisions: rows.map((r) => ({
          ...r,
          mentorName: nameOf.get(r.mentorId) ?? null,
          menteeName: nameOf.get(r.menteeId) ?? null,
          decidedByName: nameOf.get(r.decidedById) ?? null,
        })),
      });
    });
  });
}
