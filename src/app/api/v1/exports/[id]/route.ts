import { prisma } from '@/lib/prisma';
import { ANY_LIVE_KEY, requireApiScope, withApiKey } from '@/lib/apiKey';
import { apiNotFound, apiOk } from '@/lib/api/v1';
import { exportScopes, exportSelect, isExportResource, serializeExport } from '@/lib/api/v1Exports';
import { requestOrigin } from '@/lib/servedHosts';

// GET /api/v1/exports/{id} (#3002) — the export's status; a READY one carries a
// freshly signed `downloadUrl` that lives 15 minutes (never past the file's own
// `expiresAt`), so a link that leaks stops working on its own.
//
// Only the key that made the export sees it: the ownership is in the `where`
// (apiKeyId AND orgId), and another key's, another tenant's or an expired
// export is the same 404 as a missing one. The scopes the export needed are
// asked again — a key that lost them since gets the 403 its list would give.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, ANY_LIVE_KEY, async (key) => {
    const row = await prisma.apiExport.findFirst({
      where: { id, apiKeyId: key.id, orgId: key.orgId, expiresAt: { gt: new Date() } },
      select: exportSelect,
    });
    if (!row || !isExportResource(row.resource)) return apiNotFound();
    for (const scope of exportScopes(row.resource, row.withNotes)) {
      const outOfScope = requireApiScope(key, scope);
      if (outOfScope) return outOfScope;
    }
    return apiOk(serializeExport(row, requestOrigin((name) => request.headers.get(name))));
  });
}
