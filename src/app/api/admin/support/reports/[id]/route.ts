import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { reportAdminOrg, SUPPORT_REPORT_STATUSES } from '@/lib/supportReportAccess';

// One bug report (#3130): GET the full record (context + file metadata, never
// bytes), PATCH its status. Another org's id is 404, like a missing one.

const patchSchema = z.object({ status: z.enum(SUPPORT_REPORT_STATUSES) });

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return { session, orgId: await reportAdminOrg(session) };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(admin.session, async () => {
    const report = await prisma.supportReport.findFirst({
      where: { id, orgId: admin.orgId },
      include: {
        user: { select: { id: true, fullName: true, email: true, role: true } },
        files: { select: { id: true, kind: true, filename: true, contentType: true, size: true } },
      },
    });
    if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ report });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { id } = await params;
  return withTenantScope(admin.session, async () => {
    const { count } = await prisma.supportReport.updateMany({
      where: { id, orgId: admin.orgId },
      data: { status: parsed.data.status },
    });
    if (count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true, status: parsed.data.status });
  });
}
