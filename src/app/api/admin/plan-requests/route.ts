import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logCrossTenantDenial, superAdminWorld } from '@/lib/superAdmin';
import { orgWorldWhere } from '@/lib/superAdminWorld';
import { PLAN_CHANGE_STATUSES } from '@/lib/planChangeRule';

// The operator queue of plan-change requests (#1743). A SUPER ADMIN reads the
// requests of every organization of ITS OWN world (docs/worlds.md § Super
// admin) — never a tenant admin, and never across worlds. Deliberately not
// wrapped in withTenantScope: the queue spans tenants by design, and the
// explicit world filter is what bounds it.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // A super admin is always an ADMIN; the role check comes first so a lesser
  // role never reaches the flag lookup at all.
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const world = await superAdminWorld(session);
  if (!world) {
    await logCrossTenantDenial(session, 'GET /api/admin/plan-requests', null);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const raw = new URL(request.url).searchParams.get('status');
  const status = (PLAN_CHANGE_STATUSES as readonly string[]).includes(raw ?? '') ? raw! : raw === 'ALL' ? null : 'NEW';

  const rows = await prisma.planChangeRequest.findMany({
    where: { org: orgWorldWhere(world), ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      orgId: true,
      requestedById: true,
      requestedPlan: true,
      billingCycle: true,
      currentPlan: true,
      activePairs: true,
      reason: true,
      educationClaim: true,
      status: true,
      locale: true,
      handledAt: true,
      note: true,
      createdAt: true,
      updatedAt: true,
      org: { select: { name: true, slug: true } },
    },
  });

  // Requesters are not a foreign key (the record outlives the account), so
  // their names are looked up, and a deleted account simply reads as unknown.
  const people = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.requestedById))] } },
    select: { id: true, fullName: true, email: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  return NextResponse.json({
    requests: rows.map((r) => ({
      ...r,
      requestedBy: byId.get(r.requestedById) ?? null,
    })),
  });
}
