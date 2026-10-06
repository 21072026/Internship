import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { CURRENCY_RE, DEFAULT_ASSUMPTIONS, normaliseCurrency } from '@/lib/roi';
import { loadRoiReport, type RoiQuery } from '@/lib/roiReport';

// GET /api/admin/analytics/roi — the programme ROI report (#1895), every
// intermediate step included. Premium: ADVANCED_ANALYTICS, checked here against
// the caller's org — hiding the screen is not access control.
//
// Query: from, to (YYYY-MM-DD, inclusive; default the last 12 months),
// cohortId, currency (keep only cost lines in that currency), and the
// assumption overrides the screen edits as query state — nothing is saved:
//   unfilledRoleCostPerMonthMinor, vacancyMonthsAvoidedPerPlacement,
//   recruiterFeeAvoidedPerPlacementMinor, mentorHourValueMinor, mentorHours.
// A value that is not a number is a 400; a number the model refuses (not a
// whole minor amount, negative months) comes back as its typed error.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ASSUMPTION_KEYS = ['unfilledRoleCostPerMonthMinor', 'vacancyMonthsAvoidedPerPlacement', 'recruiterFeeAvoidedPerPlacementMinor', 'mentorHourValueMinor'] as const;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const validDay = (v: string | null) => (v && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const settingsOrg = await settingsOrgOf(session);
  if (!(await entitled(settingsOrg, 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const today = new Date();
  const to = validDay(params.get('to')) ?? isoDay(today);
  const defaultFrom = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate() + 1));
  let from = validDay(params.get('from')) ?? isoDay(defaultFrom);
  if (from > to) from = to;

  const assumptions: RoiQuery['assumptions'] = {};
  for (const key of ASSUMPTION_KEYS) {
    const raw = params.get(key);
    if (raw === null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return NextResponse.json({ error: 'invalid_number', field: key }, { status: 400 });
    assumptions[key] = value;
  }
  const rawHours = params.get('mentorHours');
  const mentorHours = rawHours ? Number(rawHours) : 0;
  if (!Number.isFinite(mentorHours)) return NextResponse.json({ error: 'invalid_number', field: 'mentorHours' }, { status: 400 });
  const rawCurrency = params.get('currency');
  const currency = rawCurrency && CURRENCY_RE.test(normaliseCurrency(rawCurrency)) ? normaliseCurrency(rawCurrency) : null;
  const cohortId = params.get('cohortId') || null;
  const locale = await getLocale();

  return withTenantScope(session, async () => {
    // The tenant is a hand-written conjunct (#2542): the middleware's filter is
    // a no-op while MT_ENFORCE_ISOLATION is off.
    const tenant = await tenantWhere(session);
    const [report, cohorts] = await Promise.all([
      loadRoiReport(tenant, settingsOrg, locale, { from, to, cohortId, currency, assumptions, mentorHours }),
      prisma.cohort.findMany({ where: withinTenant({}, tenant), select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return NextResponse.json({
      window: { from, to },
      cohortId,
      currency,
      mentorHours,
      defaults: DEFAULT_ASSUMPTIONS,
      cohorts,
      ...report,
    });
  });
}
