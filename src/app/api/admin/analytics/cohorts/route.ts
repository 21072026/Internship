import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { withTenantScope } from '@/lib/orgContext';

const HIRED = new Set(['HIRED_660', 'EMPLOYED_700']);
const DROPPED = new Set(['INTERNSHIP_DROPPED_460', 'INTERNSHIP_FOUND_ELSEWHERE_800']);

// GET — premium cohort comparison (Faz 2, #538). Side-by-side pipeline
// conversion, time-to-hire and engagement per cohort. Gated by the
// premiumAnalytics setting (off by default — basic analytics stay free; this
// flag becomes a per-tenant entitlement with Faz 3 multi-tenancy).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if ((await getSetting('premiumAnalytics')) !== 'true') {
    return NextResponse.json({ error: 'feature_locked' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
  const cohorts = await prisma.cohort.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      term: true,
      relations: {
        select: {
          pipelineStatus: true,
          startDate: true,
          _count: { select: { interactions: true } },
          statusChanges: {
            where: { toStatus: { in: ['HIRED_660', 'EMPLOYED_700'] } },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { createdAt: true },
          },
        },
      },
    },
  });

  const rows = cohorts.map((c) => {
    const total = c.relations.length;
    const hired = c.relations.filter((r) => HIRED.has(r.pipelineStatus)).length;
    const dropped = c.relations.filter((r) => DROPPED.has(r.pipelineStatus)).length;
    const inProgress = total - hired - dropped;
    const interactions = c.relations.reduce((n, r) => n + r._count.interactions, 0);

    // Average days from relation start to the first HIRED/EMPLOYED transition,
    // over relations that actually got hired (with a recorded transition).
    const hireDurations = c.relations
      .map((r) => (r.statusChanges[0] ? (r.statusChanges[0].createdAt.getTime() - r.startDate.getTime()) / 86_400_000 : null))
      .filter((d): d is number => d !== null && d >= 0);
    const avgDaysToHired = hireDurations.length
      ? Math.round(hireDurations.reduce((a, b) => a + b, 0) / hireDurations.length)
      : null;

    return {
      id: c.id,
      name: c.name,
      term: c.term,
      total,
      hired,
      dropped,
      inProgress,
      conversionToHired: total ? Math.round((hired / total) * 100) : 0,
      avgDaysToHired,
      interactionsPerRelation: total ? Math.round((interactions / total) * 10) / 10 : 0,
    };
  });

  return NextResponse.json({ cohorts: rows });
  });
}
