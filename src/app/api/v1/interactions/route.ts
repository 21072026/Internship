import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery, parseFilters } from '@/lib/api/v1';
import { interactionSelect, serializeInteraction } from '@/lib/api/v1Resources';

// GET /api/v1/interactions (#1990) — the v1 list contract (src/lib/api/v1.ts).
// InteractionLog has no orgId: it is scoped through its relationship's org.
// The note body is the most sensitive text in the product, so it is returned
// only to a key that ALSO holds `interactions:read_notes` — never implied.
const RESOURCE = 'interactions';

export async function GET(request: Request) {
  return withApiKey(request, 'interactions:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;
    const filters = parseFilters(request, { relationId: 'string' });
    if (filters instanceof Response) return filters;
    const withNotes = key.scopes.includes('interactions:read_notes');

    const rows = await prisma.interactionLog.findMany({
      where: {
        AND: [{ relation: { orgId: key.orgId } }, keysetWhere(query)],
        ...(filters.relationId ? { relationId: filters.relationId } : {}),
      },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: interactionSelect(withNotes),
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, query.limit);
    return apiOk(pageRows.map((row) => serializeInteraction(row, withNotes)), page);
  });
}
