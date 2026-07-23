'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3, Users, Star, BookmarkCheck, X } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';

interface CompanyAnalytics {
  funnel: Record<string, number>;
  total: number;
  interestCounts: {
    INTERESTED: number;
    SHORTLISTED: number;
    PASS: number;
    pending: number;
  };
}

// Company-scoped analytics page: candidate stage distribution and interest
// summary (EPIC: company pipeline analytics, roadmap #370).
export default function CompanyAnalyticsPage() {
  const t = useT();
  const label = useStageLabel();
  const stages = useResolvedStages();
  const [data, setData] = useState<CompanyAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/company/analytics')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((e) => { console.error('[company/analytics]', e); setError(t.common.error); })
      .finally(() => setLoading(false));
  }, [t.common.error]);

  const ca = t.companyAnalytics;
  const maxFunnel = data ? Math.max(1, ...stages.map((s) => data.funnel[s.key] || 0)) : 1;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{ca.title}</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{ca.subtitle}</p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : data ? (
        <>
          {/* Summary */}
          <div className="mb-6">
            <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 inline-flex items-center gap-3">
              <Users className="h-6 w-6 text-blue-500" />
              <div>
                <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{data.total}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">{ca.totalCandidates}</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pipeline funnel */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-blue-500" />
                  {ca.funnelTitle}
                </CardTitle>
              </CardHeader>
              {data.total === 0 ? (
                <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">{ca.noData}</p>
              ) : (
                <div className="space-y-2">
                  {stages.filter((s) => (data.funnel[s.key] ?? 0) > 0).map((s) => {
                    const count = data.funnel[s.key] ?? 0;
                    const pct = Math.round((count / maxFunnel) * 100);
                    return (
                      <div key={s.key}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-gray-700 dark:text-gray-300 truncate">{label(s.key)}</span>
                          <span className="font-semibold text-gray-900 dark:text-gray-100 ml-2 flex-shrink-0">{count}</span>
                        </div>
                        <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Interest breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Star className="h-5 w-5 text-amber-500" />
                  {ca.interestTitle}
                </CardTitle>
              </CardHeader>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-3 text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <Star className="h-4 w-4 text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-2xl font-bold text-green-700 dark:text-green-300">{data.interestCounts.INTERESTED}</p>
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1">{ca.interested}</p>
                </div>
                <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-3 text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <BookmarkCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">{data.interestCounts.SHORTLISTED}</p>
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">{ca.shortlisted}</p>
                </div>
                <div className="rounded-lg bg-red-50 dark:bg-red-950/30 p-3 text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <X className="h-4 w-4 text-red-500 dark:text-red-400" />
                  </div>
                  <p className="text-2xl font-bold text-red-700 dark:text-red-300">{data.interestCounts.PASS}</p>
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">{ca.passed}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 text-center">
                  <div className="h-5 mb-1" />
                  <p className="text-2xl font-bold text-gray-700 dark:text-gray-300">{data.interestCounts.pending}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{ca.pending}</p>
                </div>
              </div>
            </Card>
          </div>

          <div className="mt-4 text-sm text-center">
            <Link href="/company" className="text-blue-600 hover:underline">{ca.viewCandidates}</Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
