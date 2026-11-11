import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { resolveStageWipLimits } from '@/lib/stageSla';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { resolveOrgWipLimit } from '@/lib/boardWip';

// The board's work-in-progress limits (#1439), read-only, for every board that
// draws them (#2076): the admin board and the owner's board (/mentor/board,
// /sales/board). Not a second source — the same two resolvers
// GET /api/admin/stage-sla serves the settings editor from, without the SLA
// and escalation columns that editor also needs. MENTOR may read it because
// the warning is advisory decoration on their own board; editing stays ADMIN
// only, on /api/admin/stage-sla.
export async function GET(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    const defaultWipLimit = resolveOrgWipLimit(await resolveSettingRaw('boardWipLimit', { orgId: await settingsOrgOf(session) }));
    const perStage = await resolveStageWipLimits(orgId);
    return NextResponse.json({ defaultWipLimit, stages: Object.fromEntries(perStage) });
  });
}
