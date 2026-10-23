import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { reportAdminOrg } from '@/lib/supportReportAccess';

// The bytes of one report file (#3130) — the screenshot or an attachment.
// Reached through its report, so the org check is the report's.

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return { session, orgId: await reportAdminOrg(session) };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
