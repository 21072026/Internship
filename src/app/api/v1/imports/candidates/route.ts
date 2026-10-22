import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiError, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { IMPORT_BODY_MAX, IMPORT_TTL_MS, MAX_OPEN_IMPORTS_PER_KEY, importRequestSchema, serializeImport } from '@/lib/api/v1Imports';
import { enqueue } from '@/lib/jobs/queue';

// POST /api/v1/imports/candidates (#3015) — queue up to 500 candidates.
//
// Answers 202 at once; the rows are created by the `api.import.candidates` job
// on the worker through the one import engine (src/lib/api/v1Imports.ts),
// never inside this request. Each row is judged by the rules of the single
// POST /api/v1/candidates and reported on its own — a bad row is an ERROR in
// the report, not a 422 for the batch. `dryRun: true` plans and reports
// without writing. Poll GET /api/v1/imports/{id}.
export async function POST(request: Request) {
  return withApiKey(request, 'candidates:write', (key) =>
    apiWrite(
      request,
      key,
      importRequestSchema,
      async ({ candidates, dryRun }) => {
        const open = await prisma.apiImport.count({ where: { apiKeyId: key.id, orgId: key.orgId, status: { in: ['PENDING', 'RUNNING'] } } });
        if (open >= MAX_OPEN_IMPORTS_PER_KEY) {
          return apiError(409, 'limit_reached', 'Too many imports in progress', `A key may have at most ${MAX_OPEN_IMPORTS_PER_KEY} imports queued or running.`, {
            limit: MAX_OPEN_IMPORTS_PER_KEY,
          });
        }
        const row = await prisma.apiImport.create({
          data: {
            orgId: key.orgId,
            apiKeyId: key.id,
            kind: 'candidates',
            dryRun: dryRun === true,
            total: candidates.length,
            input: JSON.stringify(candidates),
            expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
          },
        });
        try {
          await enqueue('api.import.candidates', { importId: row.id }, { orgId: key.orgId, idempotencyKey: `api.import:${row.id}`, maxAttempts: 3, trigger: 'manual' });
        } catch (error) {
          await prisma.apiImport.deleteMany({ where: { id: row.id, orgId: key.orgId } }).catch(() => {});
          throw error;
        }
        return writeOk(apiOk(serializeImport(row), undefined, undefined, { status: 202, headers: { Location: `/api/v1/imports/${row.id}` } }), {
          action: 'api.import.queue',
          targetType: 'api_import',
          targetId: row.id,
          detail: `${candidates.length} candidates${dryRun ? ' (dry run)' : ''}`,
        });
      },
      { maxBodyBytes: IMPORT_BODY_MAX },
    ),
  );
}
