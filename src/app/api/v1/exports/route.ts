import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ANY_LIVE_KEY, requireApiScope, withApiKey } from '@/lib/apiKey';
import { apiError, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import {
  EXPORT_RESOURCE_NAMES,
  EXPORT_TTL_MS,
  MAX_OPEN_EXPORTS_PER_KEY,
  exportScopes,
  exportSelect,
  serializeExport,
} from '@/lib/api/v1Exports';
import { enqueue } from '@/lib/jobs/queue';
import { requestOrigin } from '@/lib/servedHosts';

// POST /api/v1/exports (#3002) — queue a full snapshot of one resource.
//
// The door is opened for any live key because the scope depends on the body:
// the export of a resource needs exactly that resource's read scope, checked
// here with requireApiScope() before anything is written (403
// `insufficient_scope`, the same refusal its list gives). Interaction note
// bodies follow the list's rule: included only when the key also holds
// `interactions:read_notes`, never asked for.
//
// Answers 202 at once: the file is written by the `api.export` job on the
// worker, never inside this request. Poll GET /api/v1/exports/{id}.
const createSchema = z.object({ resource: z.enum(EXPORT_RESOURCE_NAMES) }).strict();

export async function POST(request: Request) {
  return withApiKey(request, ANY_LIVE_KEY, (key) =>
    apiWrite(request, key, createSchema, async ({ resource }) => {
      const withNotes = resource === 'interactions' && key.scopes.includes('interactions:read_notes');
      const outOfScope = requireApiScope(key, exportScopes(resource, false)[0]);
      if (outOfScope) return outOfScope;

      const open = await prisma.apiExport.count({ where: { apiKeyId: key.id, orgId: key.orgId, status: { in: ['PENDING', 'RUNNING'] } } });
      if (open >= MAX_OPEN_EXPORTS_PER_KEY) {
        return apiError(409, 'limit_reached', 'Too many exports in progress', `A key may have at most ${MAX_OPEN_EXPORTS_PER_KEY} exports queued or running.`, {
          limit: MAX_OPEN_EXPORTS_PER_KEY,
        });
      }

      const row = await prisma.apiExport.create({
        data: { orgId: key.orgId, apiKeyId: key.id, resource, withNotes, expiresAt: new Date(Date.now() + EXPORT_TTL_MS) },
        select: exportSelect,
      });
      try {
        await enqueue('api.export', { exportId: row.id }, { orgId: key.orgId, idempotencyKey: `api.export:${row.id}`, maxAttempts: 3, trigger: 'manual' });
      } catch (error) {
        await prisma.apiExport.deleteMany({ where: { id: row.id, orgId: key.orgId } }).catch(() => {});
        throw error;
      }
      return writeOk(
        apiOk(serializeExport(row, requestOrigin((name) => request.headers.get(name))), undefined, undefined, {
          status: 202,
          headers: { Location: `/api/v1/exports/${row.id}` },
        }),
        { action: 'api.export.create', targetType: 'api_export', targetId: row.id, detail: resource },
      );
    }),
  );
}
