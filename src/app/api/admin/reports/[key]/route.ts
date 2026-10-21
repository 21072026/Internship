import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { getServerDictionary } from '@/i18n/server';
import { getReportDefinition } from '@/lib/reports/definitions';
import { loadReport, ReportUnavailable } from '@/lib/reports/registry';
import { renderReport, reportSheet, toCsv } from '@/lib/reports/render';
import { segmentFromParams } from '@/lib/reports/segmentRule';

// GET /api/admin/reports/[key]?format=json|csv|xlsx — one route for every named
// report in the registry (#1903; definitions in src/lib/reports/definitions.ts,
// loaders in src/lib/reports/registry.ts). Scheduled delivery (#1905), the BI
// extract and saved views read the same definitions through here instead of
// three parallel implementations.
//
// GATES, server-side, never by hiding a button:
//   json      → ADVANCED_ANALYTICS (the org's plan or a grant);
//   csv/xlsx  → additionally REPORT_EXPORT (#1740).
// A report whose module the org's vertical lacks is a 404.
//
// LABELS resolve here, from the caller's locale — the registry stores keys —
// so one definition serves EN, TR and DE.
//
// SEGMENTS (#1920): `segmentBy` slices any report whose definition names a
// `segmentSubject`, in the registry (one mechanism for every report); the
// floor runs after the split there. A deleted attribute answers the unsliced
// report with `segmentIgnored`, never an error.
//
// PRIVACY FLOOR: an aggregate report's small groups arrive already merged
// into one bucket (privacyFloor.ts); the response names the floor so every
// surface can footnote it. It is not a parameter.

type Format = 'json' | 'csv' | 'xlsx';

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const def = getReportDefinition((await params).key);
  if (!def) return NextResponse.json({ error: 'Unknown report' }, { status: 404 });
  const search = new URL(request.url).searchParams;
  const format = (search.get('format') || 'json') as Format;
  // Slicing (#1920): ?segmentBy=<attribute key> alone is the groupBy variant
  // (one block of rows per segment); with &segment=<value> only that segment.
  const segment = segmentFromParams({ segmentBy: search.get('segmentBy'), segment: search.get('segment') });
  if (search.get('segmentBy') && !segment) return NextResponse.json({ error: 'Invalid segmentBy' }, { status: 400 });
  if (!['json', 'csv', 'xlsx'].includes(format)) return NextResponse.json({ error: 'format must be json, csv or xlsx' }, { status: 400 });

  const orgId = await settingsOrgOf(session);
  for (const feature of format === 'json' ? (['ADVANCED_ANALYTICS'] as const) : (['ADVANCED_ANALYTICS', 'REPORT_EXPORT'] as const)) {
    if (!(await entitled(orgId, feature))) {
      return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature }, { status: 403 });
    }
  }

  const { t, locale } = await getServerDictionary();
  const R = t.reports;
  return withTenantScope(session, async () => {
    let loaded;
    try {
      loaded = await loadReport(def, { orgId, locale, stageOrgId: (session.user as { orgId?: string | null }).orgId ?? null, segment });
    } catch (error) {
      if (error instanceof ReportUnavailable) {
        return NextResponse.json({ error: error.status === 403 ? 'feature_locked' : 'Report not available' }, { status: error.status });
      }
      throw error;
    }
    const view = renderReport(def, loaded, R);

    if (format === 'json') {
      return NextResponse.json({
        key: def.key,
        title: view.title,
        description: view.description,
        columns: view.columns,
        rows: loaded.rows,
        privacyFloor: loaded.minCohort
          ? { minCohort: loaded.minCohort, suppressedGroups: loaded.suppressedGroups, bucketLabel: view.bucketLabel, note: view.floorNote }
          : null,
        segment: loaded.segment
          ? {
              ...loaded.segment,
              note: loaded.segment.suppressed ? R.segment.suppressed.replace('{n}', String(loaded.minCohort ?? '')) : null,
            }
          : null,
        segmentIgnored: loaded.segmentIgnored ? { code: loaded.segmentIgnored, note: R.segment.ignored } : null,
      });
    }

    const sheet = reportSheet(view.title, view, loaded);
    const filename = `${def.key}-${new Date().toISOString().slice(0, 10)}.${format}`;
    if (format === 'csv') {
      return new NextResponse(toCsv(sheet), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` },
      });
    }
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([sheet.columns, ...sheet.rows]), sheet.name.slice(0, 31));
    const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });
}
