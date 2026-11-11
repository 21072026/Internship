import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';

// Dismiss the console banner for a failed or stopped run (#1967). The run
// itself is unchanged; only `acknowledgedAt` is stamped.

type Ctx = { params: Promise<{ id: string; runId: string }> };

export async function POST(_request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.integrations.write', { request: _request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id, runId } = await params;
  return withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    const { count } = await prisma.rosterRun.updateMany({
      where: { id: runId, feedId: id, orgId, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });
    if (!count) {
      const exists = await prisma.rosterRun.count({ where: { id: runId, feedId: id, orgId } });
      if (!exists) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
