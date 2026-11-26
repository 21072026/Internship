import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApiScope, withApiKey } from '@/lib/apiKey';
import { apiNotFound } from '@/lib/api/v1';
import { auditSupportRead, supportReportOrgWhere } from '@/lib/api/v1Support';

// GET /api/v1/support/reports/{id}/screenshot — the report's screenshot bytes.
// An image of a real person's screen, so it needs a scope of its own on top of
// `support:read`; none of them implies another and none is a default:
//   * `support:read_screenshots`        — any report's screenshot;
//   * `support:read_shared_screenshots` — only a report an admin shared for the
//     feedback review (#3936, `screenshotSharedAt`); any other is a 404, like a
//     report without a screenshot.
// Another organisation's report, a report without a screenshot and a missing
// id are the same 404. Audited (key + id).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'support:read', async (key) => {
    const all = key.scopes.includes('support:read_screenshots');
    if (!all && !key.scopes.includes('support:read_shared_screenshots')) {
      const outOfScope = requireApiScope(key, 'support:read_screenshots');
      if (outOfScope) return outOfScope;
    }
    const file = await prisma.supportReportFile.findFirst({
      where: {
        kind: 'SCREENSHOT',
        report: { AND: [{ id }, supportReportOrgWhere(key.orgId), ...(all ? [] : [{ screenshotSharedAt: { not: null } }])] },
      },
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
