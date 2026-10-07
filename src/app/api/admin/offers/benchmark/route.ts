import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { BENCHMARK_MIN_BUCKET, benchmarkBuckets, normalizeToMonthlyMinor, type BenchmarkInput } from '@/lib/compensation';

// The offer benchmark read model (#1851): what accepted offers for a position
// pay, as count / median / p25 / p75 of the base pay normalised to a month.
//
// ADMIN only and tenant-scoped (Offer is in TENANT_MODELS, so the middleware
// injects the bound org; the role check is the door). Only ACCEPTED offers
// count — a declined figure is what someone would NOT work for — and only
// those whose base pay can be normalised: an hourly rate without hours is
// skipped rather than assumed at 40. A bucket is one position in ONE currency;
// the model never converts. Any bucket under BENCHMARK_MIN_BUCKET offers comes
// back with `null` figures and `suppressed: true` — present, never silently
// dropped — because a median over two rows is those two people's pay.
//
// Nothing is stored: the figures are derived per request from the offers
// themselves, bounded by BENCHMARK_SCAN, so an edit to one offer is reflected
// on the next read.
const BENCHMARK_SCAN = 5000;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return await withTenantScope(session, async () => {
    const sp = new URL(request.url).searchParams;
    const byContractType = sp.get('by') === 'contractType';

    const offers = await prisma.offer.findMany({
      where: { status: 'ACCEPTED', baseAmountMinor: { not: null }, currency: { not: null }, basePeriod: { not: null } },
      select: { position: true, currency: true, baseAmountMinor: true, basePeriod: true, hoursPerWeek: true, contractType: true },
      orderBy: { decidedAt: 'desc' },
      take: BENCHMARK_SCAN,
    });

    const rows: BenchmarkInput[] = [];
    for (const offer of offers) {
      const monthlyMinor = normalizeToMonthlyMinor(offer);
      if (monthlyMinor == null || !offer.currency) continue;
      rows.push({ position: offer.position, currency: offer.currency, contractType: offer.contractType, monthlyMinor });
    }

    return NextResponse.json({
      buckets: benchmarkBuckets(rows, { byContractType }),
      minBucket: BENCHMARK_MIN_BUCKET,
      by: byContractType ? 'contractType' : null,
      // How many accepted offers carried a usable figure — so the screen can
      // say "3 of 40 accepted offers have structured pay" instead of showing an
      // empty table that looks like a bug.
      measured: rows.length,
      scanned: offers.length,
      truncated: offers.length === BENCHMARK_SCAN,
    });
  });
}
