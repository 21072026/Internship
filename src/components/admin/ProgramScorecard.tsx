'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, HeartPulse } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import type { ScorecardBand, ScorecardRow } from '@/lib/programScorecard';

// The programme health scorecard (#1908): one row per indicator — value, the
// count behind it, the target, a band chip and, for an amber or red row, the
// screen where it is fixed. Shared by /admin/analytics and its print report,
// so the sponsor's printout and the coordinator's screen cannot disagree. The
// judgement is src/lib/programScorecard.ts; this only draws it.

const DOC_URL = 'https://github.com/21072026/Internship/blob/main/docs/program-scorecard.md';
const BAND_VARIANT: Record<ScorecardBand, 'success' | 'warning' | 'danger'> = { GREEN: 'success', AMBER: 'warning', RED: 'danger' };

export function ProgramScorecard() {
  const t = useT();
  const s = t.scorecard;
  const [rows, setRows] = useState<ScorecardRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/analytics/scorecard')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setRows(d?.rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null || rows.length === 0) return null;

  const fmt = (value: number, unit: 'percent' | 'days') => s.units[unit].replace('{v}', String(value));
  const target = (row: { target: number; direction: 'higher' | 'lower'; unit: 'percent' | 'days' }) =>
    (row.direction === 'higher' ? s.targetAtLeast : s.targetAtMost).replace('{v}', fmt(row.target, row.unit));

  return (
    <Card className="mb-6 break-inside-avoid" data-testid="program-scorecard">
      <CardHeader>
        <div className="flex items-center gap-2">
          <HeartPulse className="h-5 w-5 text-red-500" />
          <CardTitle>{s.title}</CardTitle>
        </div>
        <p className="text-sm text-gray-500 mt-1">{s.subtitle}</p>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-xs text-gray-500">
              <th className="py-2 pr-3 font-medium">{s.colIndicator}</th>
              <th className="py-2 pr-3 font-medium text-right">{s.colValue}</th>
              <th className="py-2 pr-3 font-medium">{s.colTarget}</th>
              <th className="py-2 pr-3 font-medium">{s.colBand}</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-testid={`scorecard-row-${row.key}`} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                <td className="py-2 pr-3 text-gray-900 dark:text-gray-100">{s.indicators[row.key]}</td>
                {row.status === 'ok' ? (
                  <>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      <span className="font-semibold text-gray-900 dark:text-gray-100" data-testid={`scorecard-value-${row.key}`}>{fmt(row.value, row.unit)}</span>
                      <span className="ml-1 text-xs text-gray-400">{s.basis.replace('{n}', String(row.basis))}</span>
                    </td>
                    <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">{target(row)}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={BAND_VARIANT[row.band]} data-testid={`scorecard-band-${row.key}`} data-band={row.band}>
                        {s.bands[row.band]}
                      </Badge>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {row.nextAction && (
                        <Link
                          href={row.nextAction}
                          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
                          data-testid={`scorecard-action-${row.key}`}
                        >
                          {s.actions[row.key as keyof typeof s.actions]} <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      )}
                    </td>
                  </>
                ) : row.status === 'insufficient' ? (
                  <>
                    <td className="py-2 pr-3 text-right text-xs text-gray-400" data-testid={`scorecard-value-${row.key}`}>{s.notEnough}</td>
                    <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">{target(row)}</td>
                    <td className="py-2 pr-3" />
                    <td className="py-2" />
                  </>
                ) : (
                  <>
                    <td className="py-2 pr-3 text-right text-xs text-gray-400" data-testid={`scorecard-value-${row.key}`}>{s.notMeasurable}</td>
                    <td className="py-2 pr-3 text-xs text-gray-400" colSpan={3}>
                      {row.dependsOn.map((n) => s.needs.replace('{n}', String(n))).join(' · ')}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <a href={DOC_URL} target="_blank" rel="noopener noreferrer" className="no-print mt-3 inline-block text-xs text-blue-600 hover:underline">
        {s.howLink}
      </a>
    </Card>
  );
}
