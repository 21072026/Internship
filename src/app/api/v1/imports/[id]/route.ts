import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { serializeImport } from '@/lib/api/v1Imports';

// GET /api/v1/imports/{id} (#3015) — the import's status and, once DONE, its
// per-row report. Only the key that queued it: the ownership is in the
// `where` (apiKeyId AND orgId), and another key's, another tenant's or an
// expired import is the same 404 as a missing one.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'candidates:write', async (key) => {
    const row = await prisma.apiImport.findFirst({
      where: { id, apiKeyId: key.id, orgId: key.orgId, expiresAt: { gt: new Date() } },
      select: { id: true, kind: true, dryRun: true, status: true, total: true, report: true, error: true, createdAt: true, finishedAt: true, expiresAt: true },
    });
    if (!row) return apiNotFound();
    return apiOk(serializeImport(row));
  });
}
