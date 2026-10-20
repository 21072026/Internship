import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery, parseFilters } from '@/lib/api/v1';
import { relationshipSelect, serializeRelationship } from '@/lib/api/v1Resources';

// GET /api/v1/relationships (#1990) — the v1 list contract (src/lib/api/v1.ts),
// scoped explicitly to the key's organisation; shape in src/lib/api/v1Resources.ts.
const RESOURCE = 'relationships';

export async function GET(request: Request) {
  return withApiKey(request, 'relationships:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;
    const filters = parseFilters(request, { status: ['ACTIVE', 'COMPLETED'], stage: 'string', mentorId: 'string', companyId: 'string' } as const);
    if (filters instanceof Response) return filters;

    const rows = await prisma.mentorshipRelation.findMany({
      where: {
        AND: [{ orgId: key.orgId }, keysetWhere(query)],
        ...(filters.status ? { status: filters.status as 'ACTIVE' | 'COMPLETED' } : {}),
        ...(filters.stage ? { pipelineStatus: filters.stage } : {}),
        ...(filters.mentorId ? { mentorId: filters.mentorId } : {}),
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
      },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: relationshipSelect,
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, query.limit);
    return apiOk(pageRows.map(serializeRelationship), page);
  });
}
