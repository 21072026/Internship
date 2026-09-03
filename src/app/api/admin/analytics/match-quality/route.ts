import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { MATCH_REASON_UNSPECIFIED } from '@/lib/matchFeedback';

// How many whole months the trend covers, including the current one.
const TREND_MONTHS = 6;

// MySQL returns BIGINT for COUNT(), which Prisma hands back as a JS BigInt.
const n = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

// First day (UTC) of the month TREND_MONTHS-1 back, so the window is six whole
// month buckets ending with the current one.
function windowStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1), 1, 0, 0, 0, 0));
}

function monthKeys(now: Date): string[] {
  const start = windowStart(now);
  return Array.from({ length: TREND_MONTHS }, (_, i) => {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

// GET — match-quality report (#2040): of the mentor suggestions we put in front
// of admins, how many get taken, at which rank position, and why the rest are
// thrown away.
//
// Everything is aggregated by the database. The interesting numbers here are
// COUNT(DISTINCT batchId) — "of N times we suggested, how often did they take
// one of ours" — which no groupBy() can express, so this uses raw SQL.
//
// Raw SQL is invisible to the tenant middleware in src/lib/orgContext.ts, so
// the orgId predicate is written out by hand below. Do not remove it.
//
// Two rates, because they answer different questions:
//   acceptanceRate  — per BATCH: did the admin take any suggestion we made?
//                     This is the "how often is your suggestion taken?" number.
//   byRank[].rate   — per ROW at that position: does our #1 actually get picked?
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    // `rank` is a reserved word in MySQL 8 — backticked everywhere below.
    const org = orgId ? Prisma.sql`AND orgId = ${orgId}` : Prisma.empty;
    const now = new Date();
    const since = windowStart(now);

    const [totalsRows, byRankRows, reasonRows, trendRows] = await Promise.all([
      prisma.$queryRaw<
        { batches: bigint; accepted: bigint; offList: bigint; shown: bigint; dismissed: bigint }[]
      >(Prisma.sql`
        SELECT
          COUNT(DISTINCT batchId) AS batches,
          COUNT(DISTINCT CASE WHEN action = 'ACCEPTED' AND \`rank\` IS NOT NULL THEN batchId END) AS accepted,
          COUNT(DISTINCT CASE WHEN action = 'ACCEPTED' AND \`rank\` IS NULL THEN batchId END) AS offList,
          COUNT(CASE WHEN \`rank\` IS NOT NULL THEN 1 END) AS shown,
          COUNT(CASE WHEN action = 'DISMISSED' THEN 1 END) AS dismissed
        FROM MatchFeedback
        WHERE createdAt >= ${since} ${org}
      `),
      prisma.$queryRaw<{ position: number; shown: bigint; accepted: bigint; dismissed: bigint }[]>(Prisma.sql`
        SELECT
          \`rank\` AS position,
          COUNT(*) AS shown,
          COUNT(CASE WHEN action = 'ACCEPTED' THEN 1 END) AS accepted,
          COUNT(CASE WHEN action = 'DISMISSED' THEN 1 END) AS dismissed
        FROM MatchFeedback
        WHERE \`rank\` IS NOT NULL AND createdAt >= ${since} ${org}
        GROUP BY \`rank\`
        ORDER BY \`rank\` ASC
      `),
      prisma.$queryRaw<{ reason: string; total: bigint }[]>(Prisma.sql`
        SELECT COALESCE(reason, ${MATCH_REASON_UNSPECIFIED}) AS reason, COUNT(*) AS total
        FROM MatchFeedback
        WHERE action = 'DISMISSED' AND createdAt >= ${since} ${org}
        GROUP BY reason
        ORDER BY total DESC, reason ASC
        LIMIT 10
      `),
      prisma.$queryRaw<{ month: string; batches: bigint; accepted: bigint }[]>(Prisma.sql`
        SELECT
          DATE_FORMAT(createdAt, '%Y-%m') AS month,
          COUNT(DISTINCT batchId) AS batches,
          COUNT(DISTINCT CASE WHEN action = 'ACCEPTED' AND \`rank\` IS NOT NULL THEN batchId END) AS accepted
        FROM MatchFeedback
        WHERE createdAt >= ${since} ${org}
        GROUP BY DATE_FORMAT(createdAt, '%Y-%m')
        ORDER BY month ASC
      `),
    ]);

    // Optional-chained rather than defaulted to a literal object: MySQL hands
    // COUNT() back as BigInt and a `0n` literal needs an ES2020 target, which
    // this tsconfig does not set.
    const t = totalsRows[0];
    const batches = n(t?.batches);
    const accepted = n(t?.accepted);

    const trendByMonth = new Map(trendRows.map((r) => [r.month, r]));
    const trend = monthKeys(now).map((month) => {
      const row = trendByMonth.get(month);
      const b = n(row?.batches);
      const a = n(row?.accepted);
      return { month, batches: b, accepted: a, rate: pct(a, b) };
    });

    return NextResponse.json({
      months: TREND_MONTHS,
      // Batch-level headline: N suggestion lists shown, of which this many
      // ended with the admin taking one of the mentors we proposed.
      batches,
      accepted,
      acceptanceRate: pct(accepted, batches),
      // Batches where the admin assigned somebody we never suggested. The
      // honest counterweight to the acceptance rate.
      offList: n(t?.offList),
      // Row-level totals across those batches.
      shown: n(t?.shown),
      dismissed: n(t?.dismissed),
      byRank: byRankRows.map((r) => {
        const s = n(r.shown);
        const a = n(r.accepted);
        return { position: Number(r.position), shown: s, accepted: a, dismissed: n(r.dismissed), rate: pct(a, s) };
      }),
      dismissReasons: reasonRows.map((r) => ({ reason: r.reason, count: n(r.total) })),
      trend,
    });
  });
}
