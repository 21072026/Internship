'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

interface CohortRow {
  id: string;
  name: string;
  term?: string | null;
  total: number;
  hired: number;
  dropped: number;
  inProgress: number;
  conversionToHired: number;
  avgDaysToHired: number | null;
  interactionsPerRelation: number;
}

// Premium cohort comparison (Faz 2, #538) on the admin analytics page: a
// side-by-side metrics table for every cohort.
//
// Mounted only when the tenant holds the premium analytics tier — the page asks
// `/api/admin/analytics/entitlements` once and renders PremiumAnalyticsLocked
// instead of this component when the answer is no (#1442). So this fetch is
// expected to succeed; a 403 here means the tier was switched off mid-session,
// and the card then simply does not draw (the reload picks up the locked panel).
export function CohortComparison() {
  const t = useT();
  const c = t.analytics;
  const [rows, setRows] = useState<CohortRow[] | null>(null);

  useEffect(() => {
    fetch('/api/admin/analytics/cohorts')
      .then(async (r) => {
        if (r.ok) setRows((await r.json()).cohorts ?? []);
      })
      .catch(() => {});
  }, []);

  if (!rows) return null;

  return (
    <Card className="mt-6" data-testid="cohort-compare">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-blue-600" />
          <CardTitle>{c.cohortCompareTitle}</CardTitle>
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 py-4">{c.cohortCompareEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="py-2 pr-3">{c.cohortName}</th>
                <th className="py-2 pr-3">{c.cohortTotal}</th>
                <th className="py-2 pr-3">{c.cohortInProgress}</th>
                <th className="py-2 pr-3">{c.cohortHired}</th>
                <th className="py-2 pr-3">{c.cohortConversion}</th>
                <th className="py-2 pr-3">{c.cohortAvgDays}</th>
                <th className="py-2">{c.cohortInteractions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">
                    {r.name}{r.term ? <span className="text-xs text-gray-400 ml-1">({r.term})</span> : null}
                  </td>
                  <td className="py-2 pr-3">{r.total}</td>
                  <td className="py-2 pr-3">{r.inProgress}</td>
                  <td className="py-2 pr-3">{r.hired}</td>
                  <td className="py-2 pr-3">{r.conversionToHired}%</td>
                  <td className="py-2 pr-3">{r.avgDaysToHired === null ? '—' : r.avgDaysToHired}</td>
                  <td className="py-2">{r.interactionsPerRelation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
