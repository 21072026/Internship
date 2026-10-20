import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery } from '@/lib/api/v1';
import { companySelect, serializeCompany } from '@/lib/api/v1Resources';

// GET /api/v1/companies (#1990) — the v1 list contract (src/lib/api/v1.ts),
// scoped explicitly to the key's organisation; shape in src/lib/api/v1Resources.ts.
const RESOURCE = 'companies';

export async function GET(request: Request) {
  return withApiKey(request, 'companies:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;

    const rows = await prisma.company.findMany({
      where: {
        AND: [{ orgId: key.orgId }, keysetWhere(query)],
      },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: companySelect,
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, query.limit);
    return apiOk(pageRows.map(serializeCompany), page);
  });
}
