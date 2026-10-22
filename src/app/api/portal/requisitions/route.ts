import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { REQUISITION_LIMITS } from '@/lib/requisitions';
import { PORTAL_JOB_SELECT, jobIdsWithSkill, visibleJobsWhere } from '@/lib/portalJobs';

// GET — the open roles a mentee can browse (#1830). MENTEE only (ADMIN for
// support); a COMPANY or MENTOR session is refused here, server-side, so no
// company reads another's board through this door. Free core: no plan or
// entitlement gate. Search and filters run in SQL; the total is a count() over
// the same where the page is sliced from.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTEE' && session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const capGate = await requireCapability(session.user.orgId, 'placements');
  if (capGate) return capGate;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ jobs: [], total: 0, page: 1, pageSize: 20 });

  const params = new URL(request.url).searchParams;
  const text = (key: string, max: number) => (params.get(key) ?? '').trim().slice(0, max) || null;
  const q = text('q', 100);
  const city = text('city', REQUISITION_LIMITS.city);
  const workMode = text('workMode', REQUISITION_LIMITS.workMode);
  const skill = text('skill', REQUISITION_LIMITS.skill);
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(REQUISITION_LIMITS.pageSize, Math.max(1, Number.parseInt(params.get('pageSize') ?? '20', 10) || 20));

  return withTenantScope(session, async () => {
    const where: Prisma.RequisitionWhereInput = {
      AND: [
        visibleJobsWhere(orgId),
        ...(q ? [{ OR: [{ title: { contains: q } }, { company: { name: { contains: q } } }] }] : []),
        ...(city ? [{ city: { contains: city } }] : []),
        ...(workMode ? [{ workMode: { contains: workMode } }] : []),
        ...(skill ? [{ id: { in: await jobIdsWithSkill(orgId, skill) } }] : []),
      ],
    };
    const [jobs, total] = await Promise.all([
      prisma.requisition.findMany({ where, select: PORTAL_JOB_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
      prisma.requisition.count({ where }),
    ]);
    return NextResponse.json({ jobs, total, page, pageSize });
  });
}
