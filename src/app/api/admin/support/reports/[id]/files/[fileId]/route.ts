import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { reportAdminOrg } from '@/lib/supportReportAccess';

// The bytes of one report file (#3130) — the screenshot or an attachment.
// Reached through its report, so the org check is the report's.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const gate = await requirePermission('support.read', { request: _request });
  if ('error' in gate) return gate.error;
  const admin = { session: gate.session, orgId: await reportAdminOrg(gate.session) };
  const { id, fileId } = await params;
  return withTenantScope(admin.session, async () => {
    const file = await prisma.supportReportFile.findFirst({
      where: { id: fileId, reportId: id, report: { orgId: admin.orgId } },
    });
    if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const disposition = file.contentType.startsWith('image/') ? 'inline' : 'attachment';
    return new NextResponse(Buffer.from(file.data), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `${disposition}; filename="${file.filename.replace(/["\r\n]/g, '')}"`,
        'Content-Length': String(file.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
