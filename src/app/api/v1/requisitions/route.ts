import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery, parseFilters } from '@/lib/api/v1';
import { requisitionSelect, serializeRequisition } from '@/lib/api/v1Resources';
import { REQUISITION_STATUSES } from '@/lib/requisitions';

// GET /api/v1/requisitions (#1990) — the v1 list contract (src/lib/api/v1.ts),
// scoped explicitly to the key's organisation; shape in src/lib/api/v1Resources.ts.
const RESOURCE = 'requisitions';

export async function GET(request: Request) {
  return withApiKey(request, 'hiring:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;
    const filters = parseFilters(request, { status: REQUISITION_STATUSES, companyId: 'string' });
    if (filters instanceof Response) return filters;

    const rows = await prisma.requisition.findMany({
      where: {
        AND: [{ orgId: key.orgId }, keysetWhere(query)],
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
      },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: requisitionSelect,
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, query.limit);
    return apiOk(pageRows.map(serializeRequisition), page);
  });
}
