import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { loadProgramScorecard } from '@/lib/programScorecardData';

// GET /api/admin/analytics/scorecard — "is this programme healthy?" (#1908):
// six measured indicators, each with its value, the count behind it, a
// green/amber/red band against a documented threshold (src/lib/programScorecard.ts)
// and, when amber or red, the screen where it is fixed. Indicators that cannot
// be measured yet say so instead of reading as 0.
//
// Part of basic analytics: free on every plan, like the screen it heads.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return withTenantScope(session, async () => {
    // The tenant is a hand-written conjunct (#2542): the middleware's filter is
    // a no-op while MT_ENFORCE_ISOLATION is off.
    const rows = await loadProgramScorecard(await tenantWhere(session));
    return NextResponse.json({ rows });
  });
}
