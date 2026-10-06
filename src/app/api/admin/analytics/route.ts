import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { getLocale } from '@/i18n/server';
import { loadAdminAnalytics } from '@/lib/adminAnalyticsData';

// GET — aggregate analytics for the admin dashboard:
// pipeline funnel, mentor workload/outcomes, engagement and RSVP rate.
// Computed in src/lib/adminAnalyticsData.ts, which the "what changed"
// narrative (#2046) reads too, so the paragraph and the cards share numbers.
//
// Time-scoped metrics (trends, engagement counts, RSVP) honour an optional
// ?from=YYYY-MM-DD&to=YYYY-MM-DD date-range window. Defaults to the last 6
// calendar months. The funnel / mentor / project distributions are current
// pipeline state, so they are intentionally NOT date-filtered.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const locale = await getLocale();
  const { searchParams } = new URL(request.url);
  return await withTenantScope(session, async () =>
    NextResponse.json(await loadAdminAnalytics(session, { from: searchParams.get('from'), to: searchParams.get('to') }, locale)),
  );
}
