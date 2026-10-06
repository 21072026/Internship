import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { buildAcceptanceReport } from '@/lib/contributorTermsReport';
import { GET as candidatesGET } from '@/app/api/candidates/route';
import { GET as analyticsGET } from '@/app/api/admin/analytics/route';
import { GET as agingGET } from '@/app/api/admin/analytics/aging/route';
import { GET as funnelGET } from '@/app/api/admin/analytics/funnel/route';
import { GET as dealValueGET } from '@/app/api/admin/analytics/deal-value/route';
import { getServerDictionary } from '@/i18n/server';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { analyticsWorkbook, candidatesSheet, fullAnalyticsWorkbook } from '@/lib/reports/workbooks';
import { toCsv } from '@/lib/reports/render';
import { tenantWhere } from '@/lib/tenantFilter';
import { loadSurveyOverview } from '@/lib/surveyOverview';
import { loadProgramScorecard } from '@/lib/programScorecardData';

// GET /api/admin/export/[dataset] — the ONE door every admin export goes
// through (#1740), gated by the org's REPORT_EXPORT entitlement (its plan or a
// grant; orgs that existed when the gate went live were grandfathered by
// prisma/backfill-report-export-grandfather.mjs, so nobody lost the export
// they had).
//
// Exports used to be built entirely in the browser from data the page already
// held, so there was nothing on the server to gate. This route now returns
// finished SHEETS — columns and rows, labels already in the caller's locale —
// built by src/lib/reports/workbooks.ts (#1903), whose named-report sheets
// come from the report registry and carry its privacy floor. The page only
// hands them to src/lib/excel.ts, which keeps SheetJS code-split. The
// candidate list also comes as a file (`?format=csv`), so no page assembles
// CSV by hand any more.
//
// Each dataset is the response of the endpoint the screen already reads,
// called in-process — so tenant scoping, the `mentorship` capability gate and
// the ADVANCED_ANALYTICS gate on the premium analytics stay exactly where they
// are, and an export can never show more than the screen it came from.
//
// What the gate does NOT do: the numbers on the analytics screen, and the
// paged candidate list, stay free to view. REPORT_EXPORT sells the file — the
// whole filtered set in one workbook — not the right to read one's own data.

const DATASETS = ['candidates', 'analytics', 'analytics-full', 'contributor-terms'] as const;
type Dataset = (typeof DATASETS)[number];

/** Call another route handler in-process with the caller's query string. */
async function internal(handler: (req: Request) => Promise<Response>, request: Request, path: string, extra: Record<string, string> = {}) {
  const url = new URL(request.url);
  const target = new URL(path, url.origin);
  url.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);
  const res = await handler(new Request(target, { headers: request.headers }));
  return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
}

export async function GET(request: Request, { params }: { params: Promise<{ dataset: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { dataset } = await params;
  if (!(DATASETS as readonly string[]).includes(dataset)) return NextResponse.json({ error: 'Unknown dataset' }, { status: 404 });
  if (!(await entitled(await settingsOrgOf(session), 'REPORT_EXPORT'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'REPORT_EXPORT' }, { status: 403 });
  }

  const orgId = await settingsOrgOf(session);
  // The full report is the premium tier's workbook: its cohort and source
  // sheets are ADVANCED_ANALYTICS reports, so the file is refused as a whole
  // rather than silently handed out without them.
  if (dataset === 'analytics-full' && !(await entitled(orgId, 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }
  const { t, locale } = await getServerDictionary();

  return withTenantScope(session, async () => {
    const stages = await resolvePipelineStages(orgId, locale);
    const label = (key: string) => stageLabel(stages, key, locale);
    switch (dataset as Dataset) {
      case 'candidates': {
        // Every matching candidate, every page — the screen's filters, with all=1.
        const res = await internal(candidatesGET, request, '/api/candidates', { all: '1' });
        if (!res.ok) return NextResponse.json({ error: 'Export failed' }, { status: res.status });
        const sheet = candidatesSheet(res.body.candidates ?? [], label);
        if (new URL(request.url).searchParams.get('format') === 'csv') {
          return new NextResponse(toCsv(sheet), {
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': `attachment; filename="candidates-${new Date().toISOString().slice(0, 10)}.csv"`,
            },
          });
        }
        return NextResponse.json({ sheets: [sheet] });
      }
      case 'contributor-terms': {
        const { rows } = await buildAcceptanceReport();
        return NextResponse.json({ rows: rows.map((r) => ({ ...r, acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null })) });
      }
      case 'analytics':
      case 'analytics-full': {
        const [analytics, aging, funnel, dealValue] = await Promise.all([
          internal(analyticsGET, request, '/api/admin/analytics'),
          internal(agingGET, request, '/api/admin/analytics/aging'),
          internal(funnelGET, request, '/api/admin/analytics/funnel'),
          // The estimated value of won deals (#2424): `enabled: false` outside
          // MARKETING, and then no sheet is written.
          internal(dealValueGET, request, '/api/admin/analytics/deal-value'),
        ]);
        if (!analytics.ok) return NextResponse.json({ error: 'Export failed' }, { status: analytics.status });
        const scorecard = await loadProgramScorecard(await tenantWhere(session));
        const surveys = await loadSurveyOverview(await tenantWhere(session), locale);
        const src = {
          analytics: analytics.body,
          aging: aging.body,
          funnel: funnel.body,
          dealValue: dealValue.ok ? dealValue.body : null,
          scorecard,
          surveys,
        };
        const ctx = { orgId, locale, stageOrgId: (session.user as { orgId?: string | null }).orgId ?? null };
        const sheets = dataset === 'analytics'
          ? await analyticsWorkbook(src, ctx, t, label)
          : await fullAnalyticsWorkbook(src, ctx, t, label);
        return NextResponse.json({ sheets });
      }
    }
  });
}
