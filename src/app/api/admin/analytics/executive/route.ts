import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { loadExecutiveReport } from '@/lib/executiveReport';

// GET /api/admin/analytics/executive — four named, deterministic 0–100 scores
// for a sponsor (#1895): engagement, progression, placement and capability,
// each over the selected period and the five equally long periods before it.
// Every score is returned with its numerator and denominator, so the screen
// shows the arithmetic, never a bare number (src/lib/executiveScores.ts).
//
// Premium: ADVANCED_ANALYTICS, checked here — hiding the screen is not access
// control. Query: from, to (YYYY-MM-DD, inclusive; default the last 90 days),
// cohortId.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const validDay = (v: string | null) => (v && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
// Six periods of up to two years each is the furthest back a trend reaches.
const MAX_PERIOD_DAYS = 731;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const settingsOrg = await settingsOrgOf(session);
  if (!(await entitled(settingsOrg, 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const to = validDay(params.get('to')) ?? isoDay(new Date());
  let from = validDay(params.get('from')) ?? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 89 * DAY));
  if (from > to) from = to;
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > (MAX_PERIOD_DAYS - 1) * DAY) {
    from = isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - (MAX_PERIOD_DAYS - 1) * DAY));
  }
  const cohortId = params.get('cohortId') || null;
  const locale = await getLocale();

  return withTenantScope(session, async () => {
    // The tenant is a hand-written conjunct (#2542).
    const tenant = await tenantWhere(session);
    const [report, cohorts] = await Promise.all([
      loadExecutiveReport(tenant, settingsOrg, locale, { from, to }, cohortId),
      prisma.cohort.findMany({ where: withinTenant({}, tenant), select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return NextResponse.json({
      window: { from, to },
      cohortId,
      cohorts,
      ...report,
      // Capability needs proficiency over time (#1822) and the skills-gap
      // report (#1823). Until both exist it is reported as not measurable —
      // never as a proxy number.
      capability: { measurable: false, dependsOn: [1822, 1823] },
    });
  });
}
