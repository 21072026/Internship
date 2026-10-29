import { prisma } from '@/lib/prisma';
import { companyOnly, withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery, parseFilters } from '@/lib/api/v1';
import { offerSelect, serializeOffer } from '@/lib/api/v1Resources';

// GET /api/v1/offers (#1990) — the v1 list contract (src/lib/api/v1.ts),
// scoped explicitly to the key's organisation; shape in src/lib/api/v1Resources.ts.
const RESOURCE = 'offers';

export async function GET(request: Request) {
  return withApiKey(request, 'hiring:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;
    const filters = parseFilters(request, { relationId: 'string', companyId: 'string' });
    if (filters instanceof Response) return filters;

    const rows = await prisma.offer.findMany({
      where: {
        AND: [{ relation: { orgId: key.orgId } }, companyOnly(key), keysetWhere(query)],
        ...(filters.relationId ? { relationId: filters.relationId } : {}),
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
      },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: offerSelect,
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, query.limit);
    return apiOk(pageRows.map(serializeOffer), page);
  }, { companyScoped: true });
}
