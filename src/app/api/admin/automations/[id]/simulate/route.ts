import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { findOrgRule, serializeRule, simulateOrgRule, validateRuleForOrg } from '@/lib/automation/admin';
import { SIMULATE_DEFAULT_LIMIT, SIMULATE_MAX_LIMIT } from '@/lib/automation/simulate';

// The dry run (#1704): replay a rule against the org's last N real stage moves
// and answer what WOULD have fired. It executes nothing — the simulation module
// cannot reach an action handler (src/lib/automation/simulate.ts). The body may
// carry an unsaved draft of the rule (`draft`), judged exactly as a saved one;
// only a dry run of the SAVED rule stamps `lastSimulatedAt`, which is what lets
// it be switched on.

const schema = z.object({
  limit: z.number().int().min(1).max(SIMULATE_MAX_LIMIT).optional(),
  draft: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { id } = await params;
  const orgId = await settingsOrgOf(gate.session);
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(gate.session, async () => {
    const current = await findOrgRule(orgId, id);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const saved = serializeRule(current);
    const candidate = parsed.data.draft ? { ...saved, ...parsed.data.draft } : saved;
    const checked = await validateRuleForOrg(orgId, {
      name: candidate.name,
      trigger: candidate.trigger,
      stageKey: candidate.stageKey,
      conditions: candidate.conditions,
      actions: candidate.actions,
      delayMinutes: candidate.delayMinutes,
      enabled: false,
    });
    if (!checked.ok) return NextResponse.json({ error: 'Validation failed', code: checked.code, issues: checked.issues }, { status: 400 });
    const result = await simulateOrgRule(orgId, checked.rule, parsed.data.limit ?? SIMULATE_DEFAULT_LIMIT);
    let lastSimulatedAt = saved.lastSimulatedAt;
    if (!parsed.data.draft) {
      const now = new Date();
      await prisma.automationRule.updateMany({ where: { id: current.id, orgId, updatedAt: current.updatedAt }, data: { lastSimulatedAt: now } });
      lastSimulatedAt = now.toISOString();
    }
    return NextResponse.json({ result, lastSimulatedAt });
  });
}
