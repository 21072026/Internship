'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Lock, Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PIPELINE_STATUSES, pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface Analytics {
  funnel: Record<string, number>;
  totalRelations: number;
  conversionToHired: number;
  mentorWorkload: { id: string; fullName: string; active: number; hired: number }[];
  trends?: { months: string[]; newRelations: number[]; interactions: number[] };
  range?: { from: string; to: string };
}
interface CohortRow { id: string; name: string; term?: string | null; total: number; inProgress: number; hired: number; conversionToHired: number; avgDaysToHired: number | null; interactionsPerRelation: number }
interface SourceRow { id: string; name: string; mentees: number; inPipeline: number; hired: number; conversionToHired: number }

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 break-inside-avoid">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">{title}</h2>
      {children}
    </section>
  );
}

const th = 'text-left text-xs text-gray-500 py-1.5 pr-4 border-b border-gray-200';
const td = 'py-1.5 pr-4 text-sm border-b border-gray-100';

// Premium full analytics report (Faz 2, #540) — a print-friendly page covering
// funnel, trends, mentor workload, cohort comparison and source conversion.
// PDF is produced via the browser's print pipeline (#357 pattern — no
// server-side binary). Locked until the premiumAnalytics setting is enabled.
export default function AnalyticsReportPage() {
  const t = useT();
  const locale = useLocale();
  const c = t.analytics;
  const [data, setData] = useState<Analytics | null>(null);
  const [cohorts, setCohorts] = useState<CohortRow[] | null>(null);
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/analytics').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/admin/analytics/cohorts').then(async (r) => (r.status === 403 ? 'locked' : r.ok ? (await r.json()).cohorts : null)),
      fetch('/api/admin/analytics/sources').then(async (r) => (r.status === 403 ? 'locked' : r.ok ? (await r.json()).sources : null)),
    ])
      .then(([a, co, so]) => {
        if (co === 'locked' || so === 'locked') { setLocked(true); return; }
        setData(a);
        setCohorts(co ?? []);
        setSources(so ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-center py-12 text-gray-400">{t.common.loading}</p>;

  if (locked) {
    return (
      <div className="max-w-xl" data-testid="report-locked">
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline mb-4">
          <ArrowLeft className="h-4 w-4" /> {c.title}
        </Link>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6 flex items-start gap-3">
          <Lock className="h-5 w-5 text-gray-400 mt-0.5" />
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">{c.fullReportTitle}</p>
            <p className="text-sm text-gray-500 mt-1">{c.cohortCompareLocked}</p>
            <Link href="/admin/settings" className="text-sm text-blue-600 hover:underline mt-1 inline-block">{c.cohortCompareUnlockCta}</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return <p className="text-center py-12 text-gray-400">{t.common.notFound}</p>;

  return (
    <div className="max-w-4xl" data-testid="full-report">
      <div className="flex items-center justify-between mb-6 no-print">
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {c.title}
        </Link>
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="h-4 w-4 mr-1" /> {c.print}
        </Button>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">{c.fullReportTitle}</h1>
      <p className="text-sm text-gray-500 mb-8">
        {data.range ? `${data.range.from} → ${data.range.to} · ` : ''}{new Date().toLocaleDateString(locale)}
      </p>

      <Section title={c.funnel}>
        <table className="w-full"><thead><tr>
          <th className={th}>{c.funnel}</th><th className={th}>#</th>
        </tr></thead><tbody>
          {PIPELINE_STATUSES.map((s) => (
            <tr key={s}><td className={td}>{pipelineLabel(s, locale)}</td><td className={td}>{data.funnel[s] || 0}</td></tr>
          ))}
        </tbody></table>
      </Section>

      {data.trends && (
        <Section title={c.trends}>
          <table className="w-full"><thead><tr>
            <th className={th}>{c.fullReportMonth}</th><th className={th}>{c.trendNewRelations}</th><th className={th}>{c.trendInteractions}</th>
          </tr></thead><tbody>
            {data.trends.months.map((m, i) => (
              <tr key={m}><td className={td}>{m}</td><td className={td}>{data.trends!.newRelations[i]}</td><td className={td}>{data.trends!.interactions[i]}</td></tr>
            ))}
          </tbody></table>
        </Section>
      )}

      <Section title={c.mentorWorkload}>
        <table className="w-full"><thead><tr>
          <th className={th}>Mentor</th><th className={th}>{c.active}</th><th className={th}>{c.hired}</th>
        </tr></thead><tbody>
          {data.mentorWorkload.map((m) => (
            <tr key={m.id}><td className={td}>{m.fullName}</td><td className={td}>{m.active}</td><td className={td}>{m.hired}</td></tr>
          ))}
        </tbody></table>
      </Section>

      <Section title={c.cohortCompareTitle}>
        {cohorts && cohorts.length > 0 ? (
          <table className="w-full"><thead><tr>
            <th className={th}>{c.cohortName}</th><th className={th}>{c.cohortTotal}</th><th className={th}>{c.cohortInProgress}</th>
            <th className={th}>{c.cohortHired}</th><th className={th}>{c.cohortConversion}</th><th className={th}>{c.cohortAvgDays}</th>
          </tr></thead><tbody>
            {cohorts.map((r) => (
              <tr key={r.id}>
                <td className={td}>{r.name}{r.term ? ` (${r.term})` : ''}</td><td className={td}>{r.total}</td><td className={td}>{r.inProgress}</td>
                <td className={td}>{r.hired}</td><td className={td}>{r.conversionToHired}%</td><td className={td}>{r.avgDaysToHired ?? '—'}</td>
              </tr>
            ))}
          </tbody></table>
        ) : <p className="text-sm text-gray-400">{c.cohortCompareEmpty}</p>}
      </Section>

      <Section title={c.sourceConversionTitle}>
        {sources && sources.length > 0 ? (
          <table className="w-full"><thead><tr>
            <th className={th}>{c.sourceName}</th><th className={th}>{c.cohortTotal}</th><th className={th}>{c.sourceInPipeline}</th>
            <th className={th}>{c.cohortHired}</th><th className={th}>{c.cohortConversion}</th>
          </tr></thead><tbody>
            {sources.map((r) => (
              <tr key={r.id}>
                <td className={td}>{r.name}</td><td className={td}>{r.mentees}</td><td className={td}>{r.inPipeline}</td>
                <td className={td}>{r.hired}</td><td className={td}>{r.conversionToHired}%</td>
              </tr>
            ))}
          </tbody></table>
        ) : <p className="text-sm text-gray-400">{c.sourceConversionEmpty}</p>}
      </Section>
    </div>
  );
}
