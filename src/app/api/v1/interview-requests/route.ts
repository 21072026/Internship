import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery, parseFilters } from '@/lib/api/v1';
import { interviewRequestSelect, serializeInterviewRequest } from '@/lib/api/v1Resources';

// GET /api/v1/interview-requests (#1990) — the v1 list contract (src/lib/api/v1.ts),
// scoped explicitly to the key's organisation; shape in src/lib/api/v1Resources.ts.
const RESOURCE = 'interview-requests';

export async function GET(request: Request) {
  return withApiKey(request, 'hiring:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;
    const filters = parseFilters(request, { requisitionId: 'string', companyId: 'string' });
    if (filters instanceof Response) return filters;

    const rows = await prisma.interviewRequest.findMany({
      where: {
        AND: [{ orgId: key.orgId }, keysetWhere(query)],
        ...(filters.requisitionId ? { requisitionId: filters.requisitionId } : {}),
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
      },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: interviewRequestSelect,
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, query.limit);
    return apiOk(pageRows.map(serializeInterviewRequest), page);
  });
}
