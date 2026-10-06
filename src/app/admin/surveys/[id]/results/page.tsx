'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import type { Breakdown, DistributionBin, QuestionResult, SurveyResults } from '@/lib/surveyResults';
import type { Nps } from '@/lib/nps';

// One survey's results (#1910). Everything that keeps a small group unreadable
// already happened on the server (src/lib/surveyResults.ts) — this screen only
// draws what it was given, and says plainly when it was given nothing.

type Dict = ReturnType<typeof useT>['surveyResults'];
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

function Bars({ bins, testId }: { bins: DistributionBin[]; testId: string }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <ul className="space-y-1" data-testid={testId}>
      {bins.map((b) => (
        <li key={b.value} className="flex items-center gap-2 text-sm">
          <span className="w-24 shrink-0 truncate text-gray-600 dark:text-gray-300" title={b.label}>{b.label}</span>
          <span className="h-3 flex-1 rounded bg-gray-100 dark:bg-gray-800" aria-hidden="true">
            <span className="block h-3 rounded bg-blue-500" style={{ width: `${(b.count / max) * 100}%` }} />
          </span>
          <span className="w-8 shrink-0 text-right tabular-nums text-gray-700 dark:text-gray-200">{b.count}</span>
        </li>
      ))}
    </ul>
  );
}

function NpsBlock({ nps, s }: { nps: Nps; s: Dict }) {
  if (nps.suppressed) return null;
  const pct = (x: number) => Math.round((x / nps.n) * 100);
  const bands = [
    { key: 'promoters', label: s.promoters, value: nps.promoters, bar: 'bg-green-500' },
    { key: 'passives', label: s.passives, value: nps.passives, bar: 'bg-gray-400' },
    { key: 'detractors', label: s.detractors, value: nps.detractors, bar: 'bg-red-500' },
  ];
  return (
    <div data-testid="nps-block">
      <p className="text-4xl font-bold text-gray-900 dark:text-gray-100" data-testid="nps-score">{nps.score}</p>
      <div className="mt-3 flex h-3 overflow-hidden rounded" aria-hidden="true">
        {bands.map((b) => <span key={b.key} className={b.bar} style={{ width: `${pct(b.value)}%` }} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-300">
        {bands.map((b) => (
          <li key={b.key} data-testid={`nps-${b.key}`}>{b.label}: {b.value} ({pct(b.value)}%)</li>
        ))}
      </ul>
    </div>
  );
}

function QuestionCard({ q, s, floor }: { q: QuestionResult; s: Dict; floor: number }) {
  const bins = q.type === 'BOOLEAN' && q.distribution
    ? q.distribution.map((b) => ({ ...b, label: b.value === 'true' ? s.yes : s.no }))
    : q.distribution;
  return (
    <Card data-testid={`question-${q.key}`}>
      <h2 className="font-semibold text-gray-900 dark:text-gray-100 break-words">{q.label}</h2>
      <p className="mb-3 text-sm text-gray-500">{fill(s.answered, { n: q.answered })}</p>
      {q.answered === 0 && <p className="text-sm text-gray-500">{s.noAnswers}</p>}
      {q.nps && <NpsBlock nps={q.nps} s={s} />}
      {q.trend && q.trend.length > 1 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">{s.trend}</h3>
          <ul className="flex flex-wrap gap-2 text-sm" data-testid={`trend-${q.key}`}>
            {q.trend.map((p) => (
              <li key={p.period} className="rounded-lg border border-gray-200 px-2 py-1 dark:border-gray-700">
                <span className="text-gray-500">{p.period}</span>{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">{p.nps ? p.nps.score : fill(s.trendHidden, { floor })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {q.mean !== undefined && q.mean !== null && <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">{fill(s.mean, { mean: q.mean })}</p>}
      {bins && q.answered > 0 && <div className="mt-3"><Bars bins={bins} testId={`dist-${q.key}`} /></div>}
      {q.texts && q.texts.length > 0 && (
        <div className="mt-2">
          <p className="mb-2 text-xs text-gray-500">{s.openText}</p>
          <ul className="space-y-2" data-testid={`texts-${q.key}`}>
            {q.texts.map((text, i) => (
              <li key={i} className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 text-sm text-gray-800 dark:text-gray-100">{text}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function BreakdownList({ title, breakdown, s, floor, label, testId }: {
  title: string;
  breakdown: Breakdown;
  s: Dict;
  floor: number;
  label?: (key: string, fallback: string) => string;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">{title}</h3>
      <ul className="space-y-1 text-sm">
        {breakdown.shown.map((b) => (
          <li key={b.key} className="flex justify-between gap-2" data-testid={`${testId}-row`}>
            <span className="truncate text-gray-700 dark:text-gray-200">{label ? label(b.key, b.label) : b.label} <span className="text-gray-500">(n={b.n})</span></span>
            <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{b.nps.score}</span>
          </li>
        ))}
        {breakdown.hidden && (
          <li className="flex items-center gap-1 text-gray-500" data-testid={`${testId}-hidden`}>
            <Lock className="h-3.5 w-3.5" /> {breakdown.shown.length > 0 ? s.residual : fill(s.hiddenGroup, { floor })}
          </li>
        )}
      </ul>
    </div>
  );
}

export default function SurveyResultsPage() {
  const t = useT();
  const s = t.surveyResults;
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<SurveyResults | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/admin/surveys/${id}/results`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => setData(body.results))
      .catch(() => setError(t.common.error));
  }, [id, t.common.error]);

  const roleLabel = (key: string, fallback: string) => (s as Record<string, string>)[`role_${key}`] ?? fallback;
  const rate = data?.responseRate;

  return (
    <div className="space-y-6">
      <Link href="/admin/surveys" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-blue-600 dark:text-blue-400">
        <ArrowLeft className="h-4 w-4" /> {s.back}
      </Link>
      {error && <p className="text-red-600" role="alert">{error}</p>}
      {!data && !error && <p className="text-gray-500">{t.common.loading}</p>}
      {data && (
        <>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 break-words" data-testid="survey-title">{data.survey.title || s.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <Badge variant="purple">{(s as Record<string, string>)[`anonymity_${data.survey.anonymity}`]}</Badge>
              <span data-testid="survey-n">{fill(s.responses, { n: data.n })}</span>
              {rate && rate.rate !== null && <span>· {fill(s.responseRate, { responded: rate.responded, invited: rate.invited, rate: rate.rate })}</span>}
            </div>
            <p className="mt-1 text-xs text-gray-500">{fill(s.floorNote, { floor: data.floor })}</p>
          </div>

          {data.suppressed ? (
            <Card data-testid="results-suppressed">
              <h2 className="flex items-center gap-2 font-semibold text-gray-900 dark:text-gray-100"><Lock className="h-4 w-4" /> {s.suppressedTitle}</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{fill(s.suppressedBody, { n: data.n, floor: data.floor })}</p>
            </Card>
          ) : (
            <>
              {data.breakdowns && (
                <Card data-testid="breakdowns">
                  <h2 className="mb-3 font-semibold text-gray-900 dark:text-gray-100">{s.breakdowns}</h2>
                  <div className="grid gap-6 sm:grid-cols-3">
                    <BreakdownList title={s.byRole} breakdown={data.breakdowns.role} s={s} floor={data.floor} label={roleLabel} testId="breakdown-role" />
                    {data.breakdowns.cohort && <BreakdownList title={s.byCohort} breakdown={data.breakdowns.cohort} s={s} floor={data.floor} testId="breakdown-cohort" />}
                    {data.breakdowns.mentor && <BreakdownList title={s.byMentor} breakdown={data.breakdowns.mentor} s={s} floor={data.floor} testId="breakdown-mentor" />}
                  </div>
                  {!data.breakdowns.cohort && !data.breakdowns.mentor && data.survey.anonymity === 'ANONYMOUS' && (
                    <p className="mt-3 text-xs text-gray-500" data-testid="no-relation-breakdowns">{s.noRelationBreakdowns}</p>
                  )}
                </Card>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                {data.questions.map((q) => <QuestionCard key={q.key} q={q} s={s} floor={data.floor} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
