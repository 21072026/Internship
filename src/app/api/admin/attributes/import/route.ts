import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { logger } from '@/lib/logger';
import { ATTRIBUTE_IMPORT_MAX_CHARS, ATTRIBUTE_IMPORT_MAX_ROWS } from '@/lib/attributeImport';
import { AttributeImportError, runAttributeImport } from '@/lib/attributeImportStore';

// POST /api/admin/attributes/import — attribute values by CSV (#1920, part 2).
// One row per person, matched on `email` within the admin's org; every other
// column names an attribute by key or label. `apply` absent/false is the
// preview: the SAME runImport() call with a writer that does not write
// (src/lib/attributeImportStore.ts), so the preview cannot diverge from the
// run (#1432). Unmatched addresses come back as SKIP `not_found`, invalid
// cells as ERROR naming the column; an empty cell never clears a value.
//
// Bounds: ADMIN only; the text is capped (ATTRIBUTE_IMPORT_MAX_CHARS) and so is
// the row count; rate-limited per admin. The activity log gets counts only.

const RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };
const MAX_BODY_BYTES = ATTRIBUTE_IMPORT_MAX_CHARS * 6 + 1024;

const bodySchema = z.object({
  text: z.string().min(1).max(ATTRIBUTE_IMPORT_MAX_CHARS),
  apply: z.boolean().optional(),
  delimiter: z.enum([',', ';', '\t', '|']).optional(),
});

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limited = enforceRateLimit(request, 'attribute-import', { ...RATE_LIMIT, subject: session.user.id });
  if (limited) return limited;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ code: 'file_too_large', maxChars: ATTRIBUTE_IMPORT_MAX_CHARS }, { status: 413 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'invalid', error: 'Validation failed' }, { status: 400 });
  const orgId = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    try {
      const report = await runAttributeImport({ orgId, text: parsed.data.text, apply: parsed.data.apply === true, delimiter: parsed.data.delimiter });
      if (!report.dryRun) {
        await logActivity({
          action: 'attributes.imported',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'Organization',
          targetId: orgId,
          detail: `rows=${report.total} ${Object.entries(report.counts).map(([s, n]) => `${s}=${n}`).join(' ')}`,
          request,
        });
      }
      return NextResponse.json({
        dryRun: report.dryRun,
        total: report.total,
        counts: report.counts,
        rows: report.rows.map((r) => ({
          row: r.row,
          key: r.key,
          status: r.status,
          ...(r.reason ? { reason: r.reason } : {}),
          ...(r.changed && r.changed.length ? { changed: r.changed } : {}),
        })),
      });
    } catch (error) {
      if (error instanceof AttributeImportError) {
        return NextResponse.json(
          { code: error.code, ...(error.column ? { column: error.column } : {}), ...(error.code === 'too_many_rows' ? { maxRows: ATTRIBUTE_IMPORT_MAX_ROWS } : {}) },
          { status: error.code === 'too_many_rows' ? 413 : 400 }
        );
      }
      // Never the message: a Prisma error can quote a value from the file.
      logger.error('attributes.import_failed', { error: error instanceof Error ? error.name : 'unknown' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
