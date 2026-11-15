import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { salesTeamReadAllowed } from '@/lib/salesBook';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { loadSalesCalendar, loadSalesTeamCalendar } from '@/lib/salesCalendar';
import { canSeeTeamFollowUpDate } from '@/lib/teamFollowUpDateRule';
import { hasSalesSurface } from '@/lib/salesSurface';
import { shellCapabilities } from '@/lib/shellCapabilities';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 62;

// GET ?from=&to= — the sales calendar's "Team" view (#3778): the caller's own
// items, as on GET /api/sales/calendar, plus their colleagues' — read-only and
// minimal (src/lib/salesCalendar.ts says what a teammate's item may carry):
// their meetings, and their follow-up DAYS where canSeeTeamFollowUpDate allows
// it — never a note. This is the only reader of that rule.
// Only for a viewer the shared team-read rule lets read the org's book
// (salesTeamReadAllowed); anyone else gets the 404 the team book answers.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;
    const teamReadAllowed = await salesTeamReadAllowed(session);
    if (!teamReadAllowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const url = new URL(request.url);
    const from = rangeStart(url.searchParams.get('from'));
    let to = rangeEnd(url.searchParams.get('to'));
    if (!from || !to || to < from) {
      return NextResponse.json({ error: 'Validation failed', code: 'invalid_range' }, { status: 400 });
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) to = new Date(from.getTime() + MAX_RANGE_DAYS * DAY_MS);

    return withTenantScope(session, async () => {
      const [own, team] = await Promise.all([
        loadSalesCalendar({ orgId: g.orgId, userId: g.userId, from, to }),
        loadSalesTeamCalendar({
          orgId: g.orgId,
          viewer: { id: g.userId },
          from,
          to,
          // Colleagues' follow-up DAYS — the date only (#3778, 2026-11-15).
          followUpDays: canSeeTeamFollowUpDate({
            teamReadAllowed,
            viewerHasSalesSurface: hasSalesSurface(session.user.role, await shellCapabilities(session.user.orgId)),
            sameOrg: g.orgId === session.user.orgId,
          }),
        }),
      ]);
      const events = [...own, ...team].sort((a, b) => a.date.localeCompare(b.date));
      return NextResponse.json({ events, from: from.toISOString(), to: to.toISOString() });
    });
  });
}
