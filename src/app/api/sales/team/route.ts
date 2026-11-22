import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { listSalesTeam } from '@/lib/leadHandoff';
import { canSeeRepOverdue } from '@/lib/salesTeamRule';
import { isSalesDispatcher } from '@/lib/salesDispatcher';

// The rep strip above the sales and admin boards: who a lead can be handed to
// (src/lib/leadHandoff.ts). MARKETING only, the caller's own org only — the
// same door as the lead pool. Names, avatars and each person's load (#3875):
// open records for everyone, overdue follow-ups only for whom the team page
// shows them (canSeeRepOverdue) — the field is null for anyone else.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;
    return withTenantScope(session, async () => {
      const withOverdue = canSeeRepOverdue({ role: session.user.role, dispatcher: await isSalesDispatcher(session.user.id) });
      const members = await listSalesTeam(g.orgId, g.userId, { withOverdue });
      return NextResponse.json({ members });
    });
  });
}
