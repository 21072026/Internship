'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3, Users, BookOpen, Target, TrendingUp, Award } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useResolvedStages } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';

interface MentorAnalytics {
  funnel: Record<string, number>;
  totalRelations: number;
  activeRelations: number;
  hired: number;
  conversionToHired: number;
  interactions: number;
  goals: { open: number; done: number; total: number };
  avgDaysToHired: number | null;
}

function StatCard({ icon: Icon, value, label, color }: { icon: React.ElementType; value: string | number; label: string; color: string }) {
  return (
    <Card>
      <div className="flex items-center gap-4">
        <div className={`w-12 h-12 ${color} rounded-xl flex items-center justify-center flex-shrink-0`}>
          <Icon className="h-6 w-6 text-white" />
        </div>
        <div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
        </div>
      </div>
    </Card>
  );
}

// Mentor-scoped analytics page: pipeline funnel, goal summary and engagement
// stats for the signed-in mentor (EPIC: mentor analytics, roadmap #370).
export default function MentorAnalyticsPage() {
  const t = useT();
  const stages = useResolvedStages();
  const [data, setData] = useState<MentorAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/mentor/analytics')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((e) => { console.error('[mentor/analytics]', e); setError(t.common.error); })
      .finally(() => setLoading(false));
  }, [t.common.error]);

  const ma = t.mentorAnalytics;

  const maxFunnel = data ? Math.max(1, ...stages.map((s) => data.funnel[s.key] || 0)) : 1;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{ma.title}</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{ma.subtitle}</p>
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
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-4 mb-8">
            <StatCard icon={Users} value={data.totalRelations} label={ma.totalMentees} color="bg-blue-500" />
            <StatCard icon={TrendingUp} value={`${data.conversionToHired}%`} label={ma.hiredRate} color="bg-green-500" />
            <StatCard icon={BookOpen} value={data.interactions} label={ma.totalInteractions} color="bg-purple-500" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Pipeline funnel */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-blue-500" />
                  {ma.funnelTitle}
                </CardTitle>
              </CardHeader>
              {data.totalRelations === 0 ? (
                <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">{ma.noData}</p>
              ) : (
                <div className="space-y-2">
                  {stages.filter((s) => (data.funnel[s.key] ?? 0) > 0).map((s) => {
                    const count = data.funnel[s.key] ?? 0;
                    const pct = Math.round((count / maxFunnel) * 100);
                    return (
                      <div key={s.key}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-gray-700 dark:text-gray-300 truncate">{s.label}</span>
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
                  {stages.every((s) => !data.funnel[s.key]) && (
                    <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">{ma.noData}</p>
                  )}
                </div>
              )}
            </Card>

            {/* Goals summary */}
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="h-5 w-5 text-amber-500" />
                    {ma.goalsTitle}
                  </CardTitle>
                </CardHeader>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
                    <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{data.goals.total}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{ma.goalsTotal}</p>
                  </div>
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 p-3">
                    <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{data.goals.open}</p>
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{ma.goalsOpen}</p>
                  </div>
                  <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-3">
                    <p className="text-2xl font-bold text-green-700 dark:text-green-300">{data.goals.done}</p>
                    <p className="text-xs text-green-600 dark:text-green-400 mt-1">{ma.goalsDone}</p>
                  </div>
                </div>
              </Card>

              {/* Hired stats */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Award className="h-5 w-5 text-green-500" />
                    {ma.outcomesTitle}
                  </CardTitle>
                </CardHeader>
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-3">
                    <p className="text-2xl font-bold text-green-700 dark:text-green-300">{data.hired}</p>
                    <p className="text-xs text-green-600 dark:text-green-400 mt-1">{ma.hired}</p>
                  </div>
                  <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-3">
                    <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                      {data.avgDaysToHired !== null ? data.avgDaysToHired : '—'}
                    </p>
                    <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">{ma.avgDaysToHired}</p>
                  </div>
                </div>
              </Card>
            </div>
          </div>

          <div className="text-sm text-gray-400 dark:text-gray-500 text-center">
            <Link href="/mentor/mentees" className="text-blue-600 hover:underline">{ma.viewMentees}</Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
