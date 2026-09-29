import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { verticalFor } from '@/lib/verticalContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { logger } from '@/lib/logger';
import { findLeadOwner } from '@/lib/leadOwner';
import { MARKETING_IMPORT_MAX_ROWS } from '@/lib/marketingImport';
import { MarketingImportError, runMarketingAccountImport } from '@/lib/marketingImportStore';

// The marketing account import, runnable in production (#2552, story #2391).
//
// WHY THIS ROUTE EXISTS
//   The CLI (`npm run import:marketing-accounts`) cannot run where the data is:
//   the runner image ships neither `scripts/` nor `src/lib/*.ts` and is
//   `node:20-slim`, while the CLI needs `--experimental-strip-types` (Node
//   ≥ 22.6). And connecting to the production database from outside is what
//   docs/DATA_ACCESS_POLICY.md forbids. So an ADMIN runs the file from the
//   /admin/settings import panel, inside the app, in their own organization.
//
// THERE IS NO SECOND ENGINE HERE
//   The body's text goes to `runMarketingAccountImport()` — the very function
//   the CLI calls: the shared parser, the import's validator, match key, diff
//   and database writer, `runImport` with a writer that does not write for the
//   preview. `apply: true` is the same call with the writing writer. This file
//   parses nothing and plans nothing; it decides who may call and shapes the
//   answer. (The legacy mentee importer next door, /api/admin/import, has its
//   own line splitter — it is the shape docs/roster-feed.md forbids repeating,
//   and nothing of it is used here.)
//
// WHO
//   ADMIN only; a MENTOR — a MARKETING org's sales rep — gets 403. Only a
//   MARKETING organization: the capability model is restrictive only, and
//   INTERNSHIP carries every capability (`companies` and `pipeline` included,
//   src/lib/verticals.ts), so `requireCapability` can never refuse it. The
//   vertical itself is therefore asked, and a non-MARKETING org is answered
//   403 `vertical_mismatch` — a code of its own, because `capability_unavailable`
//   would claim a module is missing when it is not. The capability gates are
//   still asked first, so a future vertical without the funnel is refused by
//   the rule every other writer uses.
//
// WHOSE ORGANIZATION
//   The session's, and nothing else: there is no org in the body, exactly as
//   there is no tenant column in the file (docs/marketing-import.md). The
//   default owner of the rows is the acting admin, or an owner the admin picks
//   (`ownerId`, an active ADMIN/MENTOR of the same org — else 400).
//
// BOUNDS
//   The text is capped by TEXT_LIMITS.marketingImportFile and the row count by
//   MARKETING_IMPORT_MAX_ROWS, both refused before anything is planned; the run
//   is rate-limited per admin. The activity log gets counts only (no PII) —
//   written by runMarketingAccountImport on apply, the same row the CLI writes.

const RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

const bodySchema = z.object({
  text: z.string().min(1),
  apply: z.boolean().optional(),
  authoritative: z.boolean().optional(),
  delimiter: z.enum([',', ';', '\t', '|']).optional(),
  ownerId: z.string().trim().min(1).max(64).optional(),
});

/** What the panel shows per row. The plan value (every input field) is not sent back. */
interface ReportRow {
  row: number;
  status: string;
  key: string;
  name: string | null;
  reason?: string;
  changed?: string[];
}

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ code: 'forbidden', error: 'Forbidden' }, { status: 403 });

  const orgId = session.user.orgId ?? null;
  const denied =
    (await requireCapability(orgId, 'companies')) ?? (await requireCapability(orgId, 'pipeline'));
  if (denied) return denied;
  if (!orgId || (await verticalFor(orgId)) !== 'MARKETING') {
    return NextResponse.json(
      { code: 'vertical_mismatch', error: 'The marketing account import is part of the marketing product only.' },
      { status: 403 },
    );
  }

  // Per admin, not per IP: two admins behind one office NAT do not spend each
  // other's budget, and one admin cannot loop the import.
  const limited = enforceRateLimit(request, 'marketing-import', { ...RATE_LIMIT, subject: session.user.id });
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ code: 'invalid', error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ code: 'invalid', error: 'Validation failed' }, { status: 400 });
  }
  const { text, apply, authoritative, delimiter, ownerId } = parsed.data;
  if (text.length > TEXT_LIMITS.marketingImportFile) {
    return NextResponse.json(
      { code: 'file_too_large', maxChars: TEXT_LIMITS.marketingImportFile, error: 'The file is too large for one run' },
      { status: 413 },
    );
  }

  const picked = ownerId ? await findLeadOwner(orgId, ownerId) : null;
  if (ownerId && !picked) {
    return NextResponse.json(
      { code: 'invalid_owner', error: 'Owner is not an active admin or rep of this organization' },
      { status: 400 },
    );
  }
  const owner = picked ?? { id: session.user.id, email: session.user.email ?? '', orgId, role: session.user.role };

  return withTenantScope(session, async () => {
    try {
      const { report, stageKeys } = await runMarketingAccountImport({
        text,
        ownerEmail: owner.email,
        owner,
        apply: apply === true,
        authoritative: authoritative === true,
        ...(delimiter ? { delimiter } : {}),
        maxRows: MARKETING_IMPORT_MAX_ROWS,
        actor: { id: session.user.id, email: session.user.email ?? null },
        request,
      });
      const rows: ReportRow[] = report.rows.map((r) => ({
        row: r.row,
        status: r.status,
        key: r.key,
        name: r.value?.input.name ?? null,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.changed && r.changed.length > 0 ? { changed: r.changed } : {}),
      }));
      return NextResponse.json({
        dryRun: report.dryRun,
        authoritative: authoritative === true,
        total: report.total,
        counts: report.counts,
        rows,
        stageKeys,
        owner: { id: owner.id, email: owner.email },
      });
    } catch (error) {
      if (error instanceof MarketingImportError) {
        const status = error.code === 'too_many_rows' ? 413 : 400;
        return NextResponse.json(
          { code: error.code, error: error.message, ...(error.code === 'too_many_rows' ? { maxRows: MARKETING_IMPORT_MAX_ROWS } : {}) },
          { status },
        );
      }
      // Never the message: a Prisma error can quote a value from the file.
      logger.error('marketing.accounts.import_failed', { apply: apply === true, error: error instanceof Error ? error.name : 'unknown' });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
