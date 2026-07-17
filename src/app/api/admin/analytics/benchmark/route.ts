import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { resolveOrgId } from '@/lib/orgScope';

const HIRED = new Set(['HIRED_660', 'EMPLOYED_700']);
const DROPPED = new Set(['INTERNSHIP_DROPPED_460', 'INTERNSHIP_FOUND_ELSEWHERE_800']);

// Minimum relations for a program (org) to enter the benchmark pool. This is a
// k-anonymity floor: tiny programs are excluded so an aggregate can't be
// reverse-engineered to an individual, and so noisy small samples don't skew
// the average.
const MIN_RELATIONS = 5;

// GET — premium cross-program benchmark (Faz 2, #542). Compares the viewer's
// organization's funnel conversion against an ANONYMIZED, aggregated average
// across all qualifying programs. Only aggregate numbers cross the boundary —
// never another program's identity or raw rows. Gated by premiumAnalytics.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if ((await getSetting('premiumAnalytics')) !== 'true') {
    return NextResponse.json({ error: 'feature_locked' }, { status: 403 });
  }

  // Aggregate counts per (org, stage) — never fetch raw relation rows.
  const grouped = await prisma.mentorshipRelation.groupBy({
    by: ['orgId', 'pipelineStatus'],
    _count: { _all: true },
  });

  // Fold into per-org totals: total, hired, dropped.
  type Agg = { total: number; hired: number; dropped: number };
  const byOrg = new Map<string, Agg>();
  for (const g of grouped) {
    const key = g.orgId ?? '__none__';
    const a = byOrg.get(key) ?? { total: 0, hired: 0, dropped: 0 };
    const n = g._count._all;
    a.total += n;
    if (HIRED.has(g.pipelineStatus)) a.hired += n;
    if (DROPPED.has(g.pipelineStatus)) a.dropped += n;
    byOrg.set(key, a);
  }

  const conv = (a: Agg) => (a.total > 0 ? Math.round((a.hired / a.total) * 100) : 0);
  const dropRate = (a: Agg) => (a.total > 0 ? Math.round((a.dropped / a.total) * 100) : 0);

  // The viewer's own program.
  const myOrgId = resolveOrgId(session);
  const mine = (myOrgId && byOrg.get(myOrgId)) || null;

  // Benchmark pool: every program meeting the k-anonymity floor.
  const pool = [...byOrg.values()].filter((a) => a.total >= MIN_RELATIONS);
  const poolSize = pool.length;

  const avg = (fn: (a: Agg) => number) =>
    poolSize > 0 ? Math.round(pool.reduce((s, a) => s + fn(a), 0) / poolSize) : null;

  const platformAvgConversion = avg(conv);
  const platformAvgDropRate = avg(dropRate);

  // The viewer's percentile within the pool (share of programs at or below your
  // conversion), only when the pool is large enough to be non-identifying.
  let percentile: number | null = null;
  if (mine && poolSize >= 3) {
    const myConv = conv(mine);
    const atOrBelow = pool.filter((a) => conv(a) <= myConv).length;
    percentile = Math.round((atOrBelow / poolSize) * 100);
  }

  return NextResponse.json({
    // Aggregate-only payload — no per-program identities or rows.
    you: mine
      ? { conversion: conv(mine), dropRate: dropRate(mine), total: mine.total, hired: mine.hired }
      : null,
    platform: {
      avgConversion: platformAvgConversion,
      avgDropRate: platformAvgDropRate,
      poolSize,
      minRelations: MIN_RELATIONS,
    },
    percentile,
  });
}
