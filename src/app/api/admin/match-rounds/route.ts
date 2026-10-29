import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { ROUND_NAME_MAX } from '@/lib/matching/round';

// Bulk matching rounds (#1793, story #1791) — the staging area. GET lists the
// tenant's rounds; POST opens an empty DRAFT round, optionally over a cohort of
// the tenant. Creating a round creates no relation and no proposal: the cohort
// pass (#1794) fills it, the publish path (#1796) is the only one that pairs.
// Authorization is the route's: `program.read` to list, `relation.write` to open.
const createSchema = z.object({
  name: z.string().trim().min(1).max(ROUND_NAME_MAX),
  cohortId: z.string().min(1).max(64).optional(),
});

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('program.read', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;
    return withTenantScope(session, async () => {
      const rounds = await prisma.matchRound.findMany({
        where: withinTenant({}, await tenantWhere(session)),
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { cohort: { select: { id: true, name: true } }, _count: { select: { proposals: true } } },
      });
      return NextResponse.json({ rounds });
    });
  });
}

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('relation.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    return withTenantScope(session, async () => {
      if (parsed.data.cohortId) {
        const cohort = await prisma.cohort.findFirst({
          where: withinTenant({ id: parsed.data.cohortId }, await tenantWhere(session)),
          select: { id: true },
        });
        // Another tenant's cohort reads exactly like a missing one.
        if (!cohort) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      const round = await prisma.matchRound.create({
        data: {
          orgId: resolveOrgId(session),
          cohortId: parsed.data.cohortId ?? null,
          name: parsed.data.name,
          createdById: session.user.id,
        },
      });
      return NextResponse.json({ round }, { status: 201 });
    });
  });
}
