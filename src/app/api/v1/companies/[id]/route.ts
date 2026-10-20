import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { companySelect, serializeCompany } from '@/lib/api/v1Resources';

// GET /api/v1/companies/{id} (#1990) — the same object as one element of
// the list. Another organisation's id is a 404, exactly like a missing one.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'companies:read', async (key) => {
    const row = await prisma.company.findFirst({
      where: { AND: [{ id }, { orgId: key.orgId }] },
      select: companySelect,
    });
    if (!row) return apiNotFound();
    return apiOk(serializeCompany(row));
  });
}
