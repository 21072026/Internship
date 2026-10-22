'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { REPORT_DEFINITIONS } from '@/lib/reports/definitions';
import { pick } from '@/lib/reports/render';
import { attributeLabel } from '@/lib/orgAttributesRule';

// The report registry, readable and sliceable (#1920, part 3): pick a named
// report, optionally slice it by one of the org's attributes (all segments
// side by side, or one value), read it here and download it. Everything a
// table shows comes from GET /api/admin/reports/[key] — the privacy floor and
// the segment split are applied there, never in this page.

interface Attribute {
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
  type: string;
  options: string[];
  isSegmentable: boolean;
}

interface Report {
  title: string;
  description: string;
  columns: { key: string; label: string; type: string }[];
  rows: Record<string, string | number | null>[];
  privacyFloor: { minCohort: number; suppressedGroups: number; bucketLabel: string; note: string | null } | null;
  segment: { label: string; value: string | null; suppressed: boolean; suppressedSegments: number; note: string | null } | null;
  segmentIgnored: { code: string; note: string } | null;
}

export default function AdminReportsPage() {
  const t = useT();
  const locale = useLocale();
  const L = t.reportsExplorer;
  const [reportKey, setReportKey] = useState(REPORT_DEFINITIONS[0].key);
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [segmentBy, setSegmentBy] = useState('');
  const [segment, setSegment] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/attributes')
      .then((r) => (r.ok ? r.json() : { attributes: [] }))
      .then((j) => setAttributes((j.attributes ?? []).filter((a: Attribute) => a.isSegmentable)))
      .catch(() => setAttributes([]));
  }, []);

  const def = REPORT_DEFINITIONS.find((d) => d.key === reportKey)!;
  const attr = attributes.find((a) => a.key === segmentBy);
  // The query string, built only from trusted parts: the attribute's key as
  // the server listed it (never the raw <select> value) and the typed segment
  // percent-encoded, so nothing a viewer types can change the URL's shape.
  const query = useMemo(() => {
    if (!attr || !def.segmentSubject) return '';
    const value = segment.trim();
    return `segmentBy=${encodeURIComponent(attr.key)}${value ? `&segment=${encodeURIComponent(value)}` : ''}`;
  }, [attr, segment, def.segmentSubject]);
  const base = `/api/admin/reports/${encodeURIComponent(def.key)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await fetch(`${base}?${query}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok) setReport(body);
    else {
      setReport(null);
      setError(body.code === 'feature_locked' ? L.locked : res.status === 404 ? L.unavailable : t.common.error);
    }
    setLoading(false);
  }, [base, query, L, t.common.error]);
  useEffect(() => { load(); }, [load]);

  const exportHref = (format: 'csv' | 'xlsx') => `${base}?${query ? `${query}&` : ''}format=${format}`;

  const segmentValues =
    attr?.type === 'SELECT'
      ? attr.options
      : attr?.type === 'DATE'
        ? (['lt1y', '1to3y', '3to5y', 'gte5y'] as const).map((b) => b)
        : null;
  const tenure = t.reports.segment.tenure as Record<string, string>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
        <p className="mt-1 text-gray-500">{L.subtitle}</p>
      </div>

      <Card className="mb-6">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Select
            label={L.report}
            options={REPORT_DEFINITIONS.map((d) => ({ value: d.key, label: pick(t.reports, d.titleKey) ?? d.key }))}
            value={reportKey}
            onChange={(e) => setReportKey(e.target.value)}
            data-testid="report-picker"
          />
          <Select
            label={L.sliceBy}
            options={[{ value: '', label: L.noSlice }, ...attributes.map((a) => ({ value: a.key, label: attributeLabel(a, locale) }))]}
            value={segmentBy}
            disabled={!def.segmentSubject}
            hint={def.segmentSubject ? undefined : L.notSliceable}
            onChange={(e) => {
              setSegmentBy(e.target.value);
              setSegment('');
            }}
            data-testid="segment-by-picker"
          />
          {segmentValues ? (
            <Select
              label={L.segment}
              options={[{ value: '', label: L.allSegments }, ...segmentValues.map((v) => ({ value: v, label: attr?.type === 'DATE' ? tenure[v] ?? v : v }))]}
              value={segment}
              disabled={!segmentBy}
              onChange={(e) => setSegment(e.target.value)}
              data-testid="segment-picker"
            />
          ) : (
            <Input
              label={L.segment}
              placeholder={L.allSegments}
              value={segment}
              disabled={!segmentBy}
              onChange={(e) => setSegment(e.target.value)}
              data-testid="segment-input"
            />
          )}
        </div>
        {attributes.length === 0 && <p className="mt-3 text-xs text-gray-500">{L.noAttributes}</p>}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>{report?.title ?? pick(t.reports, def.titleKey)}</CardTitle>
              <CardDescription>{report?.description ?? pick(t.reports, def.descriptionKey)}</CardDescription>
            </div>
            <div className="flex gap-2 text-sm">
              {(['csv', 'xlsx'] as const).map((f) => (
                <a
                  key={f}
                  href={exportHref(f)}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                  data-testid={`report-export-${f}`}
                >
                  <Download className="h-3.5 w-3.5" /> {f.toUpperCase()}
                </a>
              ))}
            </div>
          </div>
        </CardHeader>
        {loading ? (
          <SkeletonRows rows={5} />
        ) : error ? (
          <p className="text-sm text-red-600" role="alert" data-testid="report-error">{error}</p>
        ) : report ? (
          <div className="space-y-3">
            {report.segmentIgnored && <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="report-segment-ignored">{report.segmentIgnored.note}</p>}
            {report.segment?.suppressed ? (
              <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="report-segment-suppressed">{report.segment.note}</p>
            ) : report.rows.length === 0 ? (
              <p className="text-sm text-gray-500">{L.empty}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm" data-testid="report-table">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-700">
                      {report.columns.map((c) => (
                        <th key={c.key} className="px-2 py-2 font-medium">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row, i) => (
                      <tr key={i} className="border-b border-gray-100 dark:border-gray-800" data-testid="report-row">
                        {report.columns.map((c) => {
                          const v = row[c.key];
                          const text =
                            v === '__suppressed__' && report.privacyFloor
                              ? report.privacyFloor.bucketLabel
                              : v === null || v === undefined
                                ? '—'
                                : c.type === 'percent'
                                  ? `${v}%`
                                  : String(v);
                          return <td key={c.key} className="px-2 py-1.5 text-gray-800 dark:text-gray-200">{text}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {report.privacyFloor?.note && <p className="text-xs text-gray-500" data-testid="report-floor-note">{report.privacyFloor.note}</p>}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
