import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { reportAdminOrg, SUPPORT_REPORT_STATUSES } from '@/lib/supportReportAccess';

// The bug-report inbox (#3130): the caller's org only, newest first by default.
// ?type=BUG|FEEDBACK ?status=NEW|… ?from=YYYY-MM-DD ?to=YYYY-MM-DD (inclusive)
// ?q=<reporter name or e-mail> ?sort=oldest. No blob is read here.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const gate = await requirePermission('support.read', { request });
  if ('error' in gate) return gate.error;
  const admin = { session: gate.session, orgId: await reportAdminOrg(gate.session) };

  const p = new URL(request.url).searchParams;
  const type = p.get('type');
  const status = p.get('status');
  const from = p.get('from');
  const to = p.get('to');
  const q = p.get('q')?.trim().slice(0, 100);

  const where: Prisma.SupportReportWhereInput = { orgId: admin.orgId };
  if (type === 'BUG' || type === 'FEEDBACK') where.type = type;
  if (status && (SUPPORT_REPORT_STATUSES as readonly string[]).includes(status)) {
    where.status = status as Prisma.SupportReportWhereInput['status'];
  }
  const createdAt: Prisma.DateTimeFilter = {};
  if (from && DAY.test(from)) createdAt.gte = new Date(`${from}T00:00:00.000Z`);
  if (to && DAY.test(to)) createdAt.lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);
  if (createdAt.gte || createdAt.lt) where.createdAt = createdAt;
  if (q) where.user = { is: { OR: [{ fullName: { contains: q } }, { email: { contains: q } }] } };

  return withTenantScope(admin.session, async () => {
    const reports = await prisma.supportReport.findMany({
      where,
      orderBy: { createdAt: p.get('sort') === 'oldest' ? 'asc' : 'desc' },
      take: 100,
      select: {
        id: true, type: true, status: true, rating: true, description: true, url: true,
        contactAllowed: true, createdAt: true,
        user: { select: { id: true, fullName: true, email: true, role: true } },
        _count: { select: { files: true } },
      },
    });
    return NextResponse.json({
      reports: reports.map(({ description, ...r }) => ({ ...r, excerpt: description.slice(0, 160) })),
    });
  });
}
