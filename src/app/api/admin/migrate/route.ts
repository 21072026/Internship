import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { logActivity } from '@/lib/activity';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getLocale } from '@/i18n/server';
import { SHEETS, SHEET_FIELDS } from '@/lib/migration/migrationRules';
import { MigrationError, runMigration } from '@/lib/migration/runMigration';
import { resolvePipelineStages } from '@/lib/pipelineStages';

// POST /api/admin/migrate — a mid-programme migration (#2073): people, pairs,
// stage history and interaction logs from an incumbent's export, on the shared
// import engine (#2072). See docs/migration.md.
//
//   • ADMIN only, checked here; an internship module (`mentorship`).
//   • A DRY RUN unless the body says `confirm: true` — the preview is the
//     default, and writing is an explicit second step. The two are the same
//     code (src/lib/migration/runMigration.ts), so the preview is a promise.
//   • The org is the session's and nothing else; every created row carries it.
//   • Sends nothing: no invitation, no notification, no webhook. Inviting the
//     migrated people is a separate, deliberate step (#2070).
//   • A real run holds the org's migration lease (409 `migration_running`).

// One sheet is one CSV text; the four together are bounded so a request
// cannot buffer an arbitrary payload (1.5 MB of text per sheet).
const sheetText = z.string().max(1_500_000).optional();
const mappingFor = (sheet: (typeof SHEETS)[number]) =>
  z.record(z.enum(SHEET_FIELDS[sheet].map((f) => f.field) as [string, ...string[]]), z.string().max(200)).optional();

const bodySchema = z
  .object({
    sheets: z.object({ people: sheetText, pairs: sheetText, stageHistory: sheetText, interactions: sheetText }).strict(),
    mapping: z
      .object({ people: mappingFor('people'), pairs: mappingFor('pairs'), stageHistory: mappingFor('stageHistory'), interactions: mappingFor('interactions') })
      .strict()
      .optional(),
    stageMap: z.record(z.string().max(200), z.string().max(64)).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

// GET — this organization's stages, so the screen can offer them as stage-map
// targets before the first preview. Same gate as POST.
export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const stages = await resolvePipelineStages(await settingsOrgOf(session), await getLocale());
  return NextResponse.json({ stages: stages.map((s) => ({ key: s.key, label: s.label })) });
}

export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  // A migration is a few runs, not a stream: rehearsal, fixes, the real one.
  const limited = enforceRateLimit(request, 'admin:migrate', { limit: 20, windowMs: 10 * 60 * 1000, subject: session.user.id });
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  if (!SHEETS.some((s) => parsed.data.sheets[s]?.trim())) return NextResponse.json({ error: 'No sheet given', code: 'no_sheets' }, { status: 400 });

  const dryRun = parsed.data.confirm !== true;
  const orgId = await settingsOrgOf(session);
  const locale = await getLocale();
  return withTenantScope(session, async () => {
    try {
      const result = await runMigration(
        { sheets: parsed.data.sheets, mapping: parsed.data.mapping, stageMap: parsed.data.stageMap },
        { orgId, dryRun, locale },
      );
      if (!dryRun) {
        // Counts only — the activity log never carries the migrated people's data.
        const created = Object.entries(result.sheets).map(([sheet, r]) => `${sheet} ${r?.counts.CREATE ?? 0}`).join(', ');
        await logActivity({ action: 'program.migrate', actorId: session.user.id, actorEmail: session.user.email ?? null, detail: `created ${created}` });
      }
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof MigrationError) {
        const status = error.code === 'migration_running' ? 409 : error.code === 'too_many_rows' ? 413 : 400;
        return NextResponse.json({ error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) }, { status });
      }
      throw error;
    }
  });
}
