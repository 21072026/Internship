import { NextResponse } from 'next/server';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { requirePermission } from '@/lib/authz';
import { loadInvitationFunnel } from '@/lib/invitationFunnel';

// GET /api/admin/invitations/funnel?from=&to= (#1921)
//
// sent → opened → registered → signed in for the invitations sent in the
// range, in total and per role — counts only, never a list of people. Same
// gate and the same hand-written tenant filter as the status board beside it
// (../route.ts). The stages and what "signed in" means live in
// src/lib/invitationFunnelRule.ts.
export async function GET(request: Request) {
  const gate = await requirePermission('user.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const url = new URL(request.url);

  return await withTenantScope(session, async () => {
    const funnel = await loadInvitationFunnel(await tenantWhere(session), {
      from: rangeStart(url.searchParams.get('from')),
      to: rangeEnd(url.searchParams.get('to')),
    });
    return NextResponse.json(funnel);
  });
}
