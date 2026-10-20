import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { offerSelect, serializeOffer } from '@/lib/api/v1Resources';

// GET /api/v1/offers/{id} (#1990) — the same object as one element of
// the list. Another organisation's id is a 404, exactly like a missing one.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'hiring:read', async (key) => {
    const row = await prisma.offer.findFirst({
      where: { AND: [{ id }, { relation: { orgId: key.orgId } }] },
      select: offerSelect,
    });
    if (!row) return apiNotFound();
    return apiOk(serializeOffer(row));
  });
}
