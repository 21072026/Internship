'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3, Users, BookOpen, Target, TrendingUp, Award, ArrowRightLeft } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { AsyncSection } from '@/components/ui/AsyncSection';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { exportXlsx } from '@/lib/excel';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { useT } from '@/i18n/client';

interface MentorAnalyticsRow {
  menteeId: string;
  menteeName: string;
  pipelineStatus: string;
  daysInStage: number;
  interactions: number;
  goalsDone: number;
}

interface MentorAnalytics {
  funnel: Record<string, number>;
  totalRelations: number;
  activeRelations: number;
  hired: number;
  conversionToHired: number;
  interactions: number;
  goals: { open: number; done: number; total: number; doneInRange: number };
  avgDaysToHired: number | null;
  statusChanges: number;
  rows: MentorAnalyticsRow[];
  range: { from: string; to: string };
}

type RangePreset = '30' | '90' | '6m' | '12m' | 'all';

// Same helper as the admin analytics page: "all time" sends no bounds so the
// API falls back to its own default window.
function rangeQuery(preset: RangePreset): string {
  if (preset === 'all') return '';
  const to = new Date();
  const from = new Date(to);
  if (preset === '30') from.setDate(from.getDate() - 30);
  else if (preset === '90') from.setDate(from.getDate() - 90);
  else if (preset === '6m') from.setMonth(from.getMonth() - 6);
  else if (preset === '12m') from.setMonth(from.getMonth() - 12);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return `?from=${iso(from)}&to=${iso(to)}`;
}

function StatCard({ icon: Icon, value, label, color }: { icon: React.ElementType; value: string | number; label: string; color: string }) {
  return (
    <Card>
      {/* Two of these sit side by side on a phone: without `min-w-0` the text
          block refuses to shrink and the label runs out of the card (#1305). */}
      <div className="flex items-center gap-3 sm:gap-4">
        <div className={`w-12 h-12 ${color} rounded-xl flex items-center justify-center flex-shrink-0`}>
          <Icon className="h-6 w-6 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 break-words">{label}</p>
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
  const stageLabel = useStageLabel();
  const [range, setRange] = useState<RangePreset>('6m');
  const [data, setData] = useState<MentorAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/mentor/analytics${rangeQuery(range)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json());
    } catch (loadError) {
      console.error('[mentor/analytics]', loadError);
      setError(t.common.error);
    } finally {
      setLoading(false);
    }
  }, [range, t.common.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const ma = t.mentorAnalytics;

  // A mentor's own numbers are free core: no entitlement check here, ever.
  const exportExcel = async () => {
    if (!data) return;
    await exportXlsx(
      `mentor-analytics-${data.range.from}-${data.range.to}`,
      [ma.exportMentee, ma.exportStage, ma.exportDaysInStage, ma.exportInteractions, ma.exportGoalsDone],
      data.rows.map((r) => [
        r.menteeName,
        stageLabel(r.pipelineStatus),
        r.daysInStage,
        r.interactions,
        r.goalsDone,
      ]),
      'Mentees'
    );
  };

  const maxFunnel = data ? Math.max(1, ...stages.map((s) => data.funnel[s.key] || 0)) : 1;

  return (
    <div id="mentor-analytics-print">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{ma.title}</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">{ma.subtitle}</p>
          {data ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1" data-testid="mentor-analytics-window">
              {data.range.from} – {data.range.to}
            </p>
          ) : null}
        </div>
        {/* `no-print` is what the existing global @media print block keys off,
            so the controls disappear from the printed report with no new CSS. */}
        <div className="flex flex-wrap items-center gap-2 no-print">
          <Select
            aria-label={t.analytics.dateRange}
            className="w-auto"
            value={range}
            onChange={(e) => setRange(e.target.value as RangePreset)}
            data-testid="mentor-analytics-range"
            options={[
              { value: '30', label: t.analytics.last30 },
              { value: '90', label: t.analytics.last90 },
              { value: '6m', label: t.analytics.last6m },
              { value: '12m', label: t.analytics.last12m },
              { value: 'all', label: t.analytics.allTime },
            ]}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={exportExcel}
            disabled={!data}
            data-testid="mentor-analytics-export"
          >
            {t.analytics.exportExcel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            disabled={!data}
            data-testid="mentor-analytics-print"
          >
            {t.analytics.print}
          </Button>
        </div>
      </div>

      <AsyncSection
        loading={loading}
        error={error}
        empty={!data}
        emptyText={<p className="py-4 text-center text-sm text-gray-400 dark:text-gray-500">{ma.noData}</p>}
        retryText={t.errorBoundary.retry}
        onRetry={load}
        skeleton="stats"
      >
        {data ? (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-3">
            <StatCard icon={Users} value={data.totalRelations} label={ma.totalMentees} color="bg-blue-500" />
            <StatCard icon={TrendingUp} value={`${data.conversionToHired}%`} label={ma.hiredRate} color="bg-green-500" />
            <StatCard icon={BookOpen} value={data.interactions} label={ma.totalInteractions} color="bg-purple-500" />
            <StatCard icon={ArrowRightLeft} value={data.statusChanges} label={ma.stageMoves} color="bg-indigo-500" />
          </div>
          {/* Which numbers move with the range and which are state. Without this
              line a mentor reads a narrow window as "my pipeline shrank". */}
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-8">{ma.rangeNote}</p>

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
                {/* Three tiles across a 360px phone leave ~60px per label, which
                    is narrower than a single Turkish word ("Tamamlandı") — tighter
                    padding plus `break-words` keeps every label inside its tile
                    whatever the language (#1305). */}
                <div className="grid grid-cols-3 gap-2 sm:gap-3 text-center">
                  <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-2 sm:p-3">
                    <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{data.goals.total}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 break-words">{ma.goalsTotal}</p>
                  </div>
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 p-2 sm:p-3">
                    <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{data.goals.open}</p>
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 break-words">{ma.goalsOpen}</p>
                  </div>
                  <div className="rounded-lg bg-green-50 dark:bg-green-950/30 p-2 sm:p-3">
                    {/* Completed is an EVENT, so it follows the selected range;
                        total and open next to it are current state. rangeNote
                        under the stat cards says exactly that, which is why the
                        three tiles are allowed not to add up. */}
                    <p className="text-2xl font-bold text-green-700 dark:text-green-300" data-testid="mentor-goals-done">{data.goals.doneInRange}</p>
                    <p className="text-xs text-green-600 dark:text-green-400 mt-1 break-words">{ma.goalsDone}</p>
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
      </AsyncSection>
    </div>
  );
}
