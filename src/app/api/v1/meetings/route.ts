import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiOk, keysetWhere, paginate, parseListQuery } from '@/lib/api/v1';
import { meetingSelect, serializeMeeting, meetingOrgWhere } from '@/lib/api/v1Resources';

// GET /api/v1/meetings (#1990) — the v1 list contract (src/lib/api/v1.ts),
// scoped explicitly to the key's organisation; shape in src/lib/api/v1Resources.ts.
const RESOURCE = 'meetings';

export async function GET(request: Request) {
  return withApiKey(request, 'meetings:read', async (key) => {
    const query = parseListQuery(request, RESOURCE);
    if (query instanceof Response) return query;

    const rows = await prisma.meeting.findMany({
      where: {
        AND: [meetingOrgWhere(key.orgId), keysetWhere(query)],
      },
      orderBy: KEYSET_ORDER,
      take: query.limit + 1,
      select: meetingSelect,
    });
    const { rows: pageRows, page } = paginate(RESOURCE, rows, query.limit);
    return apiOk(pageRows.map(serializeMeeting), page);
  });
}
