import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { MAX_RULES_PER_ORG } from '@/lib/automation/rule';

// The display order of the org's rules (#1704). `ids` is the whole list in its
// new order; an id that is not this org's is refused rather than skipped. The
// order is for people: the engine runs every matching rule regardless.
const schema = z.object({ ids: z.array(z.string().min(1).max(191)).min(1).max(MAX_RULES_PER_ORG) });

export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }
  const { ids } = parsed.data;
  return withTenantScope(gate.session, async () => {
    const owned = await prisma.automationRule.count({ where: { orgId, id: { in: ids } } });
    if (owned !== ids.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await prisma.$transaction(ids.map((id, position) => prisma.automationRule.updateMany({ where: { id, orgId }, data: { position } })));
    return NextResponse.json({ ok: true });
  });
}
