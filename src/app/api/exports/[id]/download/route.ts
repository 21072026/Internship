import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { apiError, apiNotFound } from '@/lib/api/v1';
import { exportScopes, isExportResource, keyMayRead, verifyDownload } from '@/lib/api/v1Exports';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';

// GET /api/exports/{id}/download?expires=&sig= (#3002) — the file of a READY
// /api/v1 export, for whoever holds a link GET /api/v1/exports/{id} minted.
//
// No session and no API key on purpose: a link is handed to whatever fetches
// the file (a BI loader, a browser). The signature stands in for both, and it
// is narrow: HMAC over the export id and the link's own expiry (15 minutes,
// never past the file's), compared in constant time. On top of it the link is
// re-judged every time — the key that made the export must still be live,
// hold the scopes, and its org still be entitled to the API (keyMayRead) — so
// revoking the key kills every link it ever got. A tampered, expired or
// orphaned link is one 403 `invalid_link`; a link to a file that is gone, 404.
// Outside /api/v1 because the v1 door rule is "every route takes a key".
const DOWNLOAD_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const limited = enforceRateLimit(request, 'api-export-download', DOWNLOAD_RATE_LIMIT);
  if (limited) return limited;

  const url = new URL(request.url);
  if (!verifyDownload(id, url.searchParams.get('expires'), url.searchParams.get('sig'))) {
    return apiError(403, 'invalid_link', 'This download link is invalid or has expired', 'Ask GET /api/v1/exports/{id} for a fresh one.');
  }

  // The link names no tenant; the export row does. Read it unbound, then bind.
  const row = await runWithOrg(null, () =>
    prisma.apiExport.findFirst({
      where: { id, status: 'READY', expiresAt: { gt: new Date() } },
      select: { id: true, orgId: true, apiKeyId: true, resource: true, withNotes: true, content: true },
    }),
  );
  if (!row || !row.content || !isExportResource(row.resource)) return apiNotFound();
  const { resource, content } = row;

  return runWithOrg(row.orgId, async () => {
    if (!(await keyMayRead(row.apiKeyId, row.orgId, exportScopes(resource, row.withNotes)))) {
      return apiError(403, 'invalid_link', 'This download link is invalid or has expired', 'The API key that made this export no longer holds access to it.');
    }
    await logActivity({
      action: 'api.export.download',
      targetType: 'api_export',
      targetId: row.id,
      detail: `api key ${row.apiKeyId} · ${resource}`,
      orgId: row.orgId,
      request,
    });
    return new NextResponse(new Uint8Array(content), {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${resource}-${row.id}.ndjson.gz"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
