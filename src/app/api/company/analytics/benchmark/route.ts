import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { hasFeature } from '@/lib/entitlements';
import { resolveOrgId } from '@/lib/orgScope';
import { benchmarkFigures, MIN_OTHER_PROGRAMS, MIN_RELATIONS, type BenchmarkAgg } from '@/lib/benchmarkPool';
import { resolveWindow } from '@/lib/recruitingAnalytics';

// GET — the company's recruiting conversion against the anonymised average of
// the other employers in its programme (#1911, Employer Plus). Gated at the
// route by the company's ADVANCED_ANALYTICS entitlement — a direct call
// without it is a 403, not an empty card.
//
// Aggregate-only, through benchmarkPool's two floors: an employer with fewer
// than MIN_RELATIONS applications in the window never enters the pool, and no
// average or percentile leaves unless at least MIN_OTHER_PROGRAMS other
// employers qualify. The response names no employer, carries no other
// employer's count and not even the pool's size.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'COMPANY') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const companyId = session.user.companyId;
  if (!companyId) return NextResponse.json({ error: 'Forbidden', code: 'company_not_assigned' }, { status: 403 });
  if (!(await hasFeature(companyId, 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const window = resolveWindow({ from: params.get('from'), to: params.get('to') }, new Date());

  return withTenantScope(session, async () => {
    const grouped = await prisma.application.groupBy({
      by: ['companyId', 'status'],
      where: { orgId, createdAt: { gte: window.from, lte: window.to } },
      _count: { _all: true },
    });
    const byCompany = new Map<string, BenchmarkAgg>();
    for (const g of grouped) {
      const agg = byCompany.get(g.companyId) ?? { total: 0, hired: 0, dropped: 0 };
      agg.total += g._count._all;
      if (g.status === 'HIRED') agg.hired += g._count._all;
      if (g.status === 'REJECTED' || g.status === 'WITHDRAWN') agg.dropped += g._count._all;
      byCompany.set(g.companyId, agg);
    }
    const figures = benchmarkFigures(byCompany, companyId);
    return NextResponse.json({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      you: figures.you,
      avgConversion: figures.avgConversion,
      avgDropRate: figures.avgDropRate,
      percentile: figures.percentile,
      available: figures.avgConversion !== null,
      floors: { minApplications: MIN_RELATIONS, minOtherEmployers: MIN_OTHER_PROGRAMS },
    });
  });
}
