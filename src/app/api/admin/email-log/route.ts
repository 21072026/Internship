import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { authOptions } from '@/lib/auth';

// GET — the outbound mail delivery log (#1194).
//
// The question this exists to answer is "did our mail actually go out?".
// Before EmailLog there was no record at all: an unconfigured or broken SMTP
// setup looked identical to a user who simply never replied, which is how a
// batch of never-activated sign-ups stayed unexplained for days.
//
// Admin-only: recipient addresses are personal data.
const STATUSES = ['SENT', 'FAILED', 'SKIPPED'] as const;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  // Narrowed against the enum rather than passed through, so an arbitrary
  // query string can't reach Prisma as a status filter.
  const statusParam = params.get('status');
  const status = STATUSES.find((s) => s === statusParam);
  const category = params.get('category');

  const where = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
  };

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // A relay's free tier meters per *day*, so the quota question needs its own
  // window — the 7-day totals below would badly overstate today's usage.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [entries, counts, dayByTransport, dayByCategory] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        to: true,
        subject: true,
        category: true,
        transport: true,
        status: true,
        error: true,
        createdAt: true,
      },
    }),
    // A 7-day breakdown is what turns the list into a signal: a wall of
    // SKIPPED/FAILED says the problem is ours, not the recipients'.
    prisma.emailLog.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    // "How much of the relay's daily allowance have we spent?" — only SENT
    // counts against a quota; skipped mail never left the building.
    prisma.emailLog.groupBy({
      by: ['transport'],
      where: { createdAt: { gte: since24h }, status: 'SENT' },
      _count: { _all: true },
    }),
    // Which categories are the expensive ones, so a noisy job can be moved to
    // the bulk channel instead of the quota being raised.
    prisma.emailLog.groupBy({
      by: ['category', 'transport'],
      where: { createdAt: { gte: since24h }, status: 'SENT' },
      _count: { _all: true },
    }),
  ]);

  const summary = { SENT: 0, FAILED: 0, SKIPPED: 0 };
  for (const row of counts) summary[row.status] = row._count._all;

  const last24h = { primary: 0, bulk: 0 };
  for (const row of dayByTransport) {
    // Rows written before the column existed carry no transport; they predate
    // the split, so they can only have gone out on the primary channel.
    const key = row.transport === 'bulk' ? 'bulk' : 'primary';
    last24h[key] += row._count._all;
  }

  const byCategory = dayByCategory
    .map((row) => ({
      category: row.category ?? '(uncategorised)',
      transport: row.transport === 'bulk' ? 'bulk' : 'primary',
      count: row._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({ entries, summary, last24h, byCategory });
}
