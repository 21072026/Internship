import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { RUN_SUMMARY_SELECT } from '@/lib/rosterFeedAdmin';

// A feed's run history (#1967), newest first, paginated like /admin/activity.
// Dry runs included and marked. Another org's feed answers 404.

const PAGE_SIZE = 20;

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'ADMIN' ? session : null;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const page = Math.max(1, Math.floor(Number(new URL(request.url).searchParams.get('page')) || 1));
  return withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    const feed = await prisma.rosterFeed.findFirst({ where: { id, orgId }, select: { id: true } });
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const where = { feedId: id, orgId };
    const [runs, total] = await Promise.all([
      prisma.rosterRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: RUN_SUMMARY_SELECT,
      }),
      prisma.rosterRun.count({ where }),
    ]);
    return NextResponse.json({ runs, total, page, pageSize: PAGE_SIZE });
  });
}
