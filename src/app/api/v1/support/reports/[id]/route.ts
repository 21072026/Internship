import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { auditSupportRead, serializeSupportReport, supportReportOrgWhere, supportReportSelect } from '@/lib/api/v1Support';

// GET /api/v1/support/reports/{id} — the same object as one element of the
// list (`support:read`). Another organisation's id is a 404, exactly like a
// missing one; a read that finds the report is audited (key + report id).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'support:read', async (key) => {
    const row = await prisma.supportReport.findFirst({
      where: { AND: [{ id }, supportReportOrgWhere(key.orgId)] },
      select: supportReportSelect,
    });
    if (!row) return apiNotFound();
    await auditSupportRead(key, 'API_SUPPORT_REPORT_READ', [row.id]);
    return apiOk(serializeSupportReport(row));
  });
}
