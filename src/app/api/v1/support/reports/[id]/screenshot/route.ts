import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiScope, withApiKey } from '@/lib/apiKey';
import { apiNotFound } from '@/lib/api/v1';
import { auditSupportRead, supportReportOrgWhere } from '@/lib/api/v1Support';

// GET /api/v1/support/reports/{id}/screenshot — the report's screenshot bytes.
// An image of a real person's screen, so it needs its OWN scope,
// `support:read_screenshots`, on top of `support:read`; neither implies the
// other and neither is a default. Another organisation's report, a report
// without a screenshot and a missing id are the same 404. Audited (key + id).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'support:read_screenshots', async (key) => {
    const outOfScope = requireApiScope(key, 'support:read');
    if (outOfScope) return outOfScope;
    const file = await prisma.supportReportFile.findFirst({
      where: { kind: 'SCREENSHOT', report: { AND: [{ id }, supportReportOrgWhere(key.orgId)] } },
      orderBy: { createdAt: 'desc' },
      select: { contentType: true, size: true, data: true },
    });
    if (!file || !file.contentType.startsWith('image/')) return apiNotFound();
    await auditSupportRead(key, 'API_SUPPORT_REPORT_SCREENSHOT', [id]);
    return new NextResponse(Buffer.from(file.data), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Length': String(file.size),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
