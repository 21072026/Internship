import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { MIGRATION_MAX_CHARS, runAffiliateMigration } from '@/lib/affiliateMigration';

// POST — take over a previous system's affiliate history (docs/affiliate-module.md,
// #3118). `affiliate.write`, MARKETING only, the org from the session.
// Body: the three CSV texts and `dryRun` (default true — a real run is asked for
// explicitly). The answer is the same shape either way: issues, the
// reconciliation per partner, the counts, and whether anything was written.
// A run is refused as a whole (`blocked`) — never half-written.
const file = z.string().max(MIGRATION_MAX_CHARS);
const schema = z.object({
  partners: file,
  commissions: file.default(''),
  payouts: file.default(''),
  dryRun: z.boolean().default(true),
});

export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  const { dryRun, ...files } = parsed.data;

  const result = await runAffiliateMigration({ orgId, actorId: auth.session.user.id, files, dryRun });
  // Issues are many on a broken file; the first ones are enough to fix it.
  return NextResponse.json({ ...result, issues: result.issues.slice(0, 500), issueCount: result.issues.length });
}
