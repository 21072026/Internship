import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { authOptions } from '@/lib/auth';
import { superAdminWorld } from '@/lib/superAdmin';
import { worldUserWhere } from '@/lib/userWorld';

// GET — the outbound mail delivery log (#1194).
//
// The question this exists to answer is "did our mail actually go out?".
// Before EmailLog there was no record at all: an unconfigured or broken SMTP
// setup looked identical to a user who simply never replied, which is how a
// batch of never-activated sign-ups stayed unexplained for days.
//
// Super-admin only (#2635): recipient addresses are personal data, and the log
// is installation-wide — EmailLog carries no orgId, and since #2605 one address
// can be a user in two tenants, so no recipient join can say whose mail a row
// is. A tenant admin used to read every tenant's recipients and subjects here.
// The relay figures below (7-day totals, 24h quota) are installation facts too.
//
// PER WORLD (docs/worlds.md § Super admin): the super admin of one product sees
// only mail to addresses that hold an account IN ITS WORLD. EmailLog has no
// orgId, so the address is the only join there is; an address with an account
// in both worlds appears in both logs (it is the same mailbox), and mail to an
// address with no account yet (an invitation, a demo-form confirmation) appears
// in neither. The one exception is the 24h relay quota (`last24h`): both
// worlds send through the same SMTP allowance, so it stays installation-wide
// and carries no address.
const STATUSES = ['SENT', 'FAILED', 'SKIPPED'] as const;
// The reason every honoured opt-out row carries — sendEmail()'s central check
// and recordOptOuts() write the same shape (#2054).
const OPT_OUT_PREFIX = 'Unsubscribed:';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const world = await superAdminWorld(session);
  if (!world) {
    return NextResponse.json({ error: 'Forbidden', code: 'super_admin_only' }, { status: 403 });
  }
  const worldAddresses = (
    await prisma.user.findMany({ where: worldUserWhere(world), select: { email: true }, distinct: ['email'] })
  ).map((u) => u.email);
  const inWorld = { to: { in: worldAddresses } };

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  // Narrowed against the enum rather than passed through, so an arbitrary
  // query string can't reach Prisma as a status filter.
  const statusParam = params.get('status');
  const status = STATUSES.find((s) => s === statusParam);
  const category = params.get('category');
  // The opt-out proof (#2054): `suppressed=1` narrows to honoured opt-outs
  // (SKIPPED with an `Unsubscribed: <group>` reason, the one shape every path
  // writes); `to=` looks up one address — exact match, and still only inside
  // this world's addresses, so a lookup cannot read across the world line.
  const suppressed = params.get('suppressed') === '1';
  const toParam = (params.get('to') ?? '').trim().toLowerCase().slice(0, 320);
  const days = Math.min(Math.max(Math.round(Number(params.get('days')) || 7), 1), 90);

  const where = {
    ...(toParam ? { AND: [inWorld, { to: toParam }] } : inWorld),
    ...(suppressed ? { status: 'SKIPPED' as const, error: { startsWith: OPT_OUT_PREFIX } } : status ? { status } : {}),
    ...(category ? { category } : {}),
  };

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // A relay's free tier meters per *day*, so the quota question needs its own
  // window — the 7-day totals below would badly overstate today's usage.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const sinceWindow = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [entries, counts, dayByTransport, dayByCategory, optOuts] = await Promise.all([
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
      where: { ...inWorld, createdAt: { gte: since } },
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
      where: { ...inWorld, createdAt: { gte: since24h }, status: 'SENT' },
      _count: { _all: true },
    }),
    // Honoured opt-outs in the window, by reason (= group) and category (#2054).
    prisma.emailLog.groupBy({
      by: ['error', 'category'],
      where: { ...inWorld, createdAt: { gte: sinceWindow }, status: 'SKIPPED', error: { startsWith: OPT_OUT_PREFIX } },
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

  const byGroup = new Map<string, number>();
  const byOptOutCategory = new Map<string, number>();
  for (const row of optOuts) {
    const group = (row.error ?? '').slice(OPT_OUT_PREFIX.length).trim() || '(unknown)';
    byGroup.set(group, (byGroup.get(group) ?? 0) + row._count._all);
    const cat = row.category ?? '(uncategorised)';
    byOptOutCategory.set(cat, (byOptOutCategory.get(cat) ?? 0) + row._count._all);
  }
  const sorted = (m: Map<string, number>, key: 'group' | 'category') =>
    [...m.entries()].map(([k, count]) => ({ [key]: k, count })).sort((a, b) => b.count - a.count);
  const suppression = {
    days,
    total: [...byGroup.values()].reduce((a, b) => a + b, 0),
    byGroup: sorted(byGroup, 'group'),
    byCategory: sorted(byOptOutCategory, 'category'),
  };

  return NextResponse.json({ entries, summary, last24h, byCategory, suppression });
}
