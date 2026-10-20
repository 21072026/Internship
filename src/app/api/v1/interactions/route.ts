import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { KEYSET_ORDER, apiNotFound, apiOk, keysetWhere, paginate, parseListQuery, parseFilters } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { interactionSelect, serializeInteraction } from '@/lib/api/v1Resources';
import { createInteraction } from '@/lib/interactionWrite';
import { INTERACTION_TYPES } from '@/lib/interactionTypes';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { z } from 'zod';

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

// POST /api/v1/interactions (#1996) — log an interaction on a relationship of
// the key's org, through the ONE write path the UI uses
// (src/lib/interactionWrite.ts), so `interaction.logged` fires exactly once and
// the mentee's bell rings the same way. The body mirrors POST /api/interactions;
// `date` is a strict ISO-8601 instant here. The response carries the note body
// only for a key that also holds `interactions:read_notes` — writing a note is
// not reading notes.
const createSchema = z
  .object({
    relationId: z.string().min(1).max(191),
    type: z.enum(INTERACTION_TYPES),
    date: z.string().datetime({ offset: true }),
    subject: z.string().max(TEXT_LIMITS.interactionSubject).optional(),
    notes: z.string().trim().min(1).max(TEXT_LIMITS.interactionNotes),
  })
  .strict();

export async function POST(request: Request) {
  return withApiKey(request, 'interactions:write', (key) =>
    apiWrite(request, key, createSchema, async (body) => {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: { id: body.relationId, orgId: key.orgId },
        select: { id: true, orgId: true, menteeId: true },
      });
      if (!relation) return apiNotFound();
      const created = await createInteraction({
        relation,
        date: new Date(body.date),
        type: body.type,
        notes: body.notes,
        subject: body.subject,
        actorId: null,
      });
      const withNotes = key.scopes.includes('interactions:read_notes');
      const row = await prisma.interactionLog.findUniqueOrThrow({ where: { id: created.id }, select: interactionSelect(withNotes) });
      return writeOk(apiOk(serializeInteraction(row, withNotes), undefined, undefined, { status: 201 }), {
        action: 'api.interaction.create',
        targetType: 'interaction',
        targetId: created.id,
      });
    }),
  );
}
