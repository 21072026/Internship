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
import { GET as cohortsGET } from '@/app/api/admin/analytics/cohorts/route';
import { GET as sourcesGET } from '@/app/api/admin/analytics/sources/route';

// GET /api/admin/export/[dataset] — the ONE door every admin export goes
// through (#1740), gated by the org's REPORT_EXPORT entitlement (its plan or a
// grant; orgs that existed when the gate went live were grandfathered by
// prisma/backfill-report-export-grandfather.mjs, so nobody lost the export
// they had).
//
// Exports used to be built entirely in the browser from data the page already
// held, so there was nothing on the server to gate. This route returns the
// DATA each workbook is made from; the page keeps turning it into the file
// with src/lib/excel.ts, which preserves the SheetJS code-splitting and the
// screens' own label helpers. Moving the row SHAPES server-side as named,
// localized definitions is the report registry's job (#1903), which will
// resolve against this same route rather than add a second one.
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

  return withTenantScope(session, async () => {
    switch (dataset as Dataset) {
      case 'candidates': {
        // Every matching candidate, every page — the screen's filters, with all=1.
        const res = await internal(candidatesGET, request, '/api/candidates', { all: '1' });
        if (!res.ok) return NextResponse.json({ error: 'Export failed' }, { status: res.status });
        return NextResponse.json({ candidates: res.body.candidates ?? [] });
      }
      case 'contributor-terms': {
        const { rows } = await buildAcceptanceReport();
        return NextResponse.json({ rows: rows.map((r) => ({ ...r, acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null })) });
      }
      case 'analytics':
      case 'analytics-full': {
        const [analytics, aging, funnel] = await Promise.all([
          internal(analyticsGET, request, '/api/admin/analytics'),
          internal(agingGET, request, '/api/admin/analytics/aging'),
          internal(funnelGET, request, '/api/admin/analytics/funnel'),
        ]);
        if (!analytics.ok) return NextResponse.json({ error: 'Export failed' }, { status: analytics.status });
        const base = { analytics: analytics.body, aging: aging.body, funnel: funnel.body };
        if (dataset === 'analytics') return NextResponse.json(base);
        // The premium sheets keep their own gate (ADVANCED_ANALYTICS) and the
        // cohort report its `mentorship` capability: a locked one is null here,
        // exactly as the screen would have it.
        const [cohorts, sources] = await Promise.all([
          internal(cohortsGET, request, '/api/admin/analytics/cohorts'),
          internal(sourcesGET, request, '/api/admin/analytics/sources'),
        ]);
        return NextResponse.json({
          ...base,
          cohorts: cohorts.ok ? cohorts.body.cohorts ?? [] : null,
          sources: sources.ok ? sources.body.sources ?? [] : null,
        });
      }
    }
  });
}
