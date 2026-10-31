import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { getLocale } from '@/i18n/server';
import { loadAdminAnalytics } from '@/lib/adminAnalyticsData';
import { tenantWhere } from '@/lib/tenantFilter';
import { resolveProgramFilter } from '@/lib/programFilter';

// GET — aggregate analytics for the admin dashboard:
// pipeline funnel, mentor workload/outcomes, engagement and RSVP rate.
// Computed in src/lib/adminAnalyticsData.ts, which the "what changed"
// narrative (#2046) reads too, so the paragraph and the cards share numbers.
//
// Time-scoped metrics (trends, engagement counts, RSVP) honour an optional
// ?from=YYYY-MM-DD&to=YYYY-MM-DD date-range window. Defaults to the last 6
// calendar months. The funnel / mentor / project distributions are current
// pipeline state, so they are intentionally NOT date-filtered.
//
// An optional ?program=<id>|unassigned narrows every relation-based number to
// one programme (#1652) — free on every plan; another org's id is a 404
// (src/lib/programFilter.ts).
export async function GET(request: Request) {
  // A list read (#1577): a PROGRAM_ADMIN with grants passes and every number
  // is computed over them (loadAdminAnalytics `scope`); other tiers get
  // `grants` undefined and read their whole org. The other analytics routes
  // still refuse a PROGRAM_ADMIN.
  const gate = await requirePermission('analytics.read', { request, listing: true });
  if ('error' in gate) return gate.error;
  const { session, grants } = gate;

  const locale = await getLocale();
  const { searchParams } = new URL(request.url);
  return await withTenantScope(session, async () => {
    const program = await resolveProgramFilter(searchParams.get('program'), await tenantWhere(session));
    if ('error' in program) return program.error;
    return NextResponse.json(
      await loadAdminAnalytics(session, { from: searchParams.get('from'), to: searchParams.get('to'), program: program.filter, scope: grants }, locale),
    );
  });
}
