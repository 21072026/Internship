import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withRequestScope } from '@/lib/requestContext';
import { reportAdminOrg } from '@/lib/supportReportAccess';
import { ORG_MAIL_LOG_LIMIT, mailLogReason, parseOrgMailLogQuery } from '@/lib/orgMailLogRule';

// GET /api/admin/mail-log — the org admin's own mail log (#3955): did a mail to
// one of OUR people go out, and if not, why. `mail.read`, every vertical.
//
// Only rows stamped with the admin's organization (`EmailLog.orgId` is the
// RECIPIENT's tenant, which every writer stamps, #1556). A row without an
// orgId — legacy, or an address with no account — is never shown here: whose
// it is cannot be told, and the deployment-wide log stays the super admin's
// (GET /api/admin/email-log, #2635). No relay quota or installation figure
// either. The recipient address is shown: it is the org's own person, read by
// the org's admin; nothing here is exported.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('mail.read', { request });
    if ('error' in gate) return gate.error;
    const orgId = await reportAdminOrg(gate.session);
    const q = parseOrgMailLogQuery(new URL(request.url).searchParams);
    const since = new Date(Date.now() - q.days * 24 * 60 * 60 * 1000);
    const rows = await prisma.emailLog.findMany({
      where: {
        orgId,
        createdAt: { gte: since },
        ...(q.status ? { status: q.status } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.to ? { to: q.to } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ORG_MAIL_LOG_LIMIT,
      select: { id: true, createdAt: true, status: true, category: true, to: true, error: true },
    });
    const categories = await prisma.emailLog.groupBy({
      by: ['category'],
      where: { orgId, createdAt: { gte: since } },
      _count: { _all: true },
    });
    return NextResponse.json({
      days: q.days,
      rows: rows.map(({ error, ...r }) => ({ ...r, reason: mailLogReason(error) })),
      categories: categories
        .filter((c) => c.category)
        .map((c) => ({ category: c.category as string, count: c._count._all }))
        .sort((a, b) => a.category.localeCompare(b.category)),
      limited: rows.length === ORG_MAIL_LOG_LIMIT,
    });
  });
}
