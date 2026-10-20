import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { interactionSelect, serializeInteraction } from '@/lib/api/v1Resources';

// GET /api/v1/interactions/{id} (#1990) — the same object as one element of
// the list, note body included only for `interactions:read_notes`. Another
// organisation's id is a 404, exactly like a missing one.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'interactions:read', async (key) => {
    const withNotes = key.scopes.includes('interactions:read_notes');
    const row = await prisma.interactionLog.findFirst({
      where: { AND: [{ id }, { relation: { orgId: key.orgId } }] },
      select: interactionSelect(withNotes),
    });
    if (!row) return apiNotFound();
    return apiOk(serializeInteraction(row, withNotes));
  });
}
