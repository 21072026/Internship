import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { logger } from '@/lib/logger';
import { requireCapability } from '@/lib/capabilityGate';
import { MENTOR_LIMITS_IMPORT_MAX_CHARS, MENTOR_LIMITS_IMPORT_MAX_ROWS } from '@/lib/mentorLimitsImport';
import { MentorLimitsImportError, runMentorLimitsImport } from '@/lib/mentorLimitsImportStore';
import { requirePermission } from '@/lib/authz';

// POST /api/admin/mentors/limits/import — per-mentor load limits by CSV (#1808).
// Columns: email + any of mentorCapacity, selfMatchLimit, acceptingMentees
// (User) and minNoticeMinutes, maxPerMonth (the mentor's MentorBookingPolicy,
// #2003). `apply` absent/false is the dry run — the SAME runImport() call with
// a writer that does not write (src/lib/mentorLimitsImportStore.ts); only a
// second call with `apply: true` writes. An unknown address is reported as SKIP
// `not_found`, never created. Free core: no plan gate.
//
// Bounds: ADMIN only, checked here; text and row count capped; rate-limited per
// admin. The activity log gets counts only.

const RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };
const MAX_BODY_BYTES = MENTOR_LIMITS_IMPORT_MAX_CHARS * 6 + 1024;

const bodySchema = z.object({
  text: z.string().min(1).max(MENTOR_LIMITS_IMPORT_MAX_CHARS),
  apply: z.boolean().optional(),
  delimiter: z.enum([',', ';', '\t', '|']).optional(),
});

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const limited = enforceRateLimit(request, 'mentor-limits-import', { ...RATE_LIMIT, subject: session.user.id });
  if (limited) return limited;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ code: 'file_too_large', maxChars: MENTOR_LIMITS_IMPORT_MAX_CHARS }, { status: 413 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'invalid', error: 'Validation failed' }, { status: 400 });
  const orgId = await settingsOrgOf(session);
  const denied = await requireCapability(orgId, 'mentorship');
  if (denied) return denied;

  return withTenantScope(session, async () => {
    try {
      const report = await runMentorLimitsImport({ orgId, text: parsed.data.text, apply: parsed.data.apply === true, delimiter: parsed.data.delimiter });
      if (!report.dryRun) {
        await logActivity({
          action: 'mentor_limits.imported',
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
      if (error instanceof MentorLimitsImportError) {
        return NextResponse.json(
          { code: error.code, ...(error.column ? { column: error.column } : {}), ...(error.code === 'too_many_rows' ? { maxRows: MENTOR_LIMITS_IMPORT_MAX_ROWS } : {}) },
          { status: error.code === 'too_many_rows' ? 413 : 400 }
        );
      }
      // Never the message: a Prisma error can quote a value from the file.
      logger.error('mentor_limits.import_failed', { error: error instanceof Error ? error.name : 'unknown' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
