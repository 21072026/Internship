import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { reportAdminOrg } from '@/lib/supportReportAccess';

// Share a report's screenshot with the feedback review, or take it back (#3936).
// While shared, an API key holding `support:read_shared_screenshots` may read
// the image (GET /api/v1/support/reports/{id}/screenshot); nothing else changes.
// The admin's own decision, per report, so a real person's screen is seen only
// where someone chose to show it. support.write; another org's report is 404;
// a report without a screenshot is 409 (there is nothing to share). Audited.

const schema = z.object({ shared: z.boolean() });

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('support.write', { request });
    if ('error' in gate) return gate.error;
    const session = gate.session;
    const orgId = await reportAdminOrg(session);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { id } = await params;
    return withTenantScope(session, async () => {
      const report = await prisma.supportReport.findFirst({
        where: { id, orgId },
        select: { screenshotSharedAt: true, _count: { select: { files: { where: { kind: 'SCREENSHOT' } } } } },
      });
      if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (report._count.files === 0) return NextResponse.json({ error: 'This report has no screenshot', code: 'no_screenshot' }, { status: 409 });
      const isShared = !!report.screenshotSharedAt;
      if (isShared === parsed.data.shared) return NextResponse.json({ shared: isShared, unchanged: true });
      const sharedAt = parsed.data.shared ? new Date() : null;
      await prisma.$transaction([
        prisma.supportReport.updateMany({
          where: { id, orgId },
          data: { screenshotSharedAt: sharedAt, screenshotSharedById: parsed.data.shared ? session.user.id : null },
        }),
        prisma.auditLog.create({
          data: {
            orgId,
            actorId: session.user.id,
            action: parsed.data.shared ? 'support_report.screenshot_shared' : 'support_report.screenshot_unshared',
            targetId: id,
          },
        }),
      ]);
      return NextResponse.json({ shared: parsed.data.shared, sharedAt });
    });
  });
}
