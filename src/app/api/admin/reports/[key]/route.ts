import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { getServerDictionary } from '@/i18n/server';
import { getReportDefinition, type ReportDefinition } from '@/lib/reports/definitions';
import { loadReport, ReportUnavailable } from '@/lib/reports/registry';
import { SUPPRESSED_LABEL, type Row } from '@/lib/reports/privacyFloor';

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
// PRIVACY FLOOR: an aggregate report's small groups arrive already merged
// into one bucket (privacyFloor.ts); the response names the floor so every
// surface can footnote it. It is not a parameter.

type Format = 'json' | 'csv' | 'xlsx';

function pick(obj: unknown, path: string): string | undefined {
  const v = path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  return typeof v === 'string' ? v : undefined;
}

function cell(def: ReportDefinition, key: string, value: Row[string], bucketLabel: string): string | number {
  if (value === null || value === undefined) return '';
  if (value === SUPPRESSED_LABEL && key === def.labelColumn) return bucketLabel;
  const type = def.columns.find((c) => c.key === key)?.type;
  if (type === 'percent' && typeof value === 'number') return `${value}%`;
  return value;
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const def = getReportDefinition((await params).key);
  if (!def) return NextResponse.json({ error: 'Unknown report' }, { status: 404 });
  const format = (new URL(request.url).searchParams.get('format') || 'json') as Format;
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
      loaded = await loadReport(def, { session, orgId, locale, request });
    } catch (error) {
      if (error instanceof ReportUnavailable) {
        return NextResponse.json({ error: error.status === 403 ? 'feature_locked' : 'Report not available' }, { status: error.status });
      }
      throw error;
    }
    const title = pick(R, def.titleKey) ?? def.key;
    const columns = def.columns.map((c) => ({ key: c.key, label: pick(R, c.labelKey) ?? c.key, type: c.type }));
    const bucketLabel = loaded.minCohort ? R.suppressedBucket.replace('{n}', String(loaded.minCohort)) : '';
    const floorNote = loaded.minCohort ? R.floorNote.replace('{n}', String(loaded.minCohort)) : null;

    if (format === 'json') {
      return NextResponse.json({
        key: def.key,
        title,
        description: pick(R, def.descriptionKey) ?? '',
        columns,
        rows: loaded.rows,
        privacyFloor: loaded.minCohort ? { minCohort: loaded.minCohort, suppressedGroups: loaded.suppressedGroups, bucketLabel, note: floorNote } : null,
      });
    }

    const header = columns.map((c) => c.label);
    const body = loaded.rows.map((r) => def.columns.map((c) => cell(def, c.key, r[c.key], bucketLabel)));
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${def.key}-${stamp}.${format}`;
    if (format === 'csv') {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [header, ...body].map((row) => row.map(esc).join(','));
      if (floorNote && loaded.suppressedGroups > 0) lines.push('', esc(floorNote));
      return new NextResponse('﻿' + lines.join('\n'), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` },
      });
    }
    const XLSX = await import('xlsx');
    const rows: (string | number)[][] = [header, ...body];
    if (floorNote && loaded.suppressedGroups > 0) rows.push([], [floorNote]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), title.slice(0, 31));
    const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });
}
