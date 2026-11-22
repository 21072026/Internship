import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseFilters, parseListQuery } from '@/lib/api/v1';
import { SUPPORT_REPORT_STATUSES } from '@/lib/supportReportStatus';
import {
  SUPPORT_REPORT_PAGE_MAX,
  auditSupportRead,
  serializeSupportReport,
  supportReportOrgWhere,
  supportReportSelect,
} from '@/lib/api/v1Support';

// GET /api/v1/support/reports — the organisation's in-app bug reports and
// feedback, READ-ONLY, for a key holding `support:read` (src/lib/api/v1Support.ts
// says what leaves and how it is masked). The v1 list contract: keyset on
// (updatedAt, id), `?updatedSince=` (alias `?since=`), `?cursor=`, `?limit=`
// (clamped to 50 here), plus `?status=` and `?type=`. Every call writes one
// AuditLog row naming the key and the report ids it returned.
const RESOURCE = 'support-reports';

export async function GET(request: Request) {
  return withApiKey(request, 'support:read', async (key) => {
    // `since` is the name a poller reaches for; it means exactly `updatedSince`.
    const url = new URL(request.url);
    const since = url.searchParams.get('since');
    if (since !== null && !url.searchParams.has('updatedSince')) url.searchParams.set('updatedSince', since);
    const query = parseListQuery(new Request(url), RESOURCE);
    if (query instanceof Response) return query;
    const filters = parseFilters(request, { status: SUPPORT_REPORT_STATUSES, type: ['BUG', 'FEEDBACK'] as const });
    if (filters instanceof Response) return filters;
    const limit = Math.min(query.limit, SUPPORT_REPORT_PAGE_MAX);

    const rows = await prisma.supportReport.findMany({
      where: {
        AND: [
          supportReportOrgWhere(key.orgId),
          keysetWhere(query),
          ...(filters.status ? [{ status: filters.status as (typeof SUPPORT_REPORT_STATUSES)[number] }] : []),
          ...(filters.type ? [{ type: filters.type as 'BUG' | 'FEEDBACK' }] : []),
        ],
      },
      orderBy: KEYSET_ORDER,
      take: limit + 1,
      select: supportReportSelect,
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, limit);
    await auditSupportRead(key, 'API_SUPPORT_REPORT_LIST', pageRows.map((r) => r.id));
    return apiOk(pageRows.map(serializeSupportReport), page);
  });
}
