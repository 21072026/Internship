'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Lock, Users } from 'lucide-react';
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

// Premium cohort comparison (Faz 2, #538) on the admin analytics page.
// Locked (403 feature_locked) until the premiumAnalytics setting is enabled —
// then renders a side-by-side metrics table for every cohort.
export function CohortComparison() {
  const t = useT();
  const c = t.analytics;
  const [rows, setRows] = useState<CohortRow[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/analytics/cohorts')
      .then(async (r) => {
        if (r.status === 403) { setLocked(true); return; }
        if (r.ok) setRows((await r.json()).cohorts ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  if (locked) {
    return (
      <Card className="mt-6" data-testid="cohort-compare-locked">
        <div className="flex items-start gap-3">
          <Lock className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{c.cohortCompareTitle}</p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{c.cohortCompareLocked}</p>
            <Link href="/admin/settings" className="text-sm text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block">
              {c.cohortCompareUnlockCta}
            </Link>
          </div>
        </div>
      </Card>
    );
  }

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
