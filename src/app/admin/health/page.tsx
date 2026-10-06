'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { HeartPulse, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { HEALTH_RULES, HEALTH_RULES_VERSION, type HealthBand, type HealthReason } from '@/lib/relationHealth';
import type { NextAction } from '@/lib/healthNextAction';

// The org-wide at-risk queue (#1902): every active relationship, worst first,
// with its reasons and exactly one next action that goes somewhere. The
// mentor-side sibling is MentorAttentionQueue (unchanged); the reason chips
// reuse its translated strings so both screens name a problem the same way.

const RULES_DOC_URL = 'https://github.com/21072026/Internship/blob/main/docs/relationship-health.md';

interface Row {
  relationId: string;
  score: number | null;
  band: HealthBand;
  reasons: HealthReason[];
  daysSinceLastInteraction: number | null;
  trend7: number | null;
  trend30: number | null;
  series: { day: string; score: number | null; band: HealthBand }[];
  mentor: { id: string; name: string };
  mentee: { id: string; name: string };
  stage: { key: string; label: string };
  cohort: { id: string; name: string } | null;
  nextAction: NextAction | null;
}

interface HealthResponse {
  counts: { HEALTHY: number; WATCH: number; AT_RISK: number; crossed7: number };
  excluded: { dormant: number; notActive: number; quiet: number };
  total: number;
  page: number;
  pageSize: number;
  rows: Row[];
  filters: { mentors: { id: string; name: string }[]; cohorts: { id: string; name: string }[]; stages: { key: string; label: string }[] };
  rulesVersion: number;
}

const BAND_VARIANT: Record<HealthBand, 'success' | 'warning' | 'danger'> = { HEALTHY: 'success', WATCH: 'warning', AT_RISK: 'danger' };
const BAND_BAR: Record<HealthBand, string> = { HEALTHY: 'bg-green-500', WATCH: 'bg-amber-500', AT_RISK: 'bg-red-500' };
const REASON_VARIANT: Record<HealthReason, 'warning' | 'danger' | 'info' | 'purple'> = {
  inactive: 'warning',
  overdue: 'danger',
  unanswered_question: 'info',
  pending_meeting: 'purple',
  no_open_goal: 'info',
  missing_weekly_reports: 'danger',
  stage_stalled: 'warning',
};

export default function AdminHealthPage() {
  const t = useT();
  const h = t.adminHealth;
  const router = useRouter();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [band, setBand] = useState('');
  const [mentorId, setMentorId] = useState('');
  const [cohortId, setCohortId] = useState('');
  const [stage, setStage] = useState('');
  const [page, setPage] = useState(1);
  const [opening, setOpening] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(page) });
    if (band) params.set('band', band);
    if (mentorId) params.set('mentorId', mentorId);
    if (cohortId) params.set('cohortId', cohortId);
    if (stage) params.set('stage', stage);
    try {
      const res = await fetch(`/api/admin/health?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
    } catch {
      setError(t.common.error);
    } finally {
      setLoading(false);
    }
  }, [band, mentorId, cohortId, stage, page, t.common.error]);

  useEffect(() => {
    load();
  }, [load]);

  // Any filter change returns to the first page.
  useEffect(() => {
    setPage(1);
  }, [band, mentorId, cohortId, stage]);

  const reasonLabel: Record<HealthReason, string> = {
    inactive: t.mentor.attention.inactive,
    overdue: t.mentor.attention.overdue,
    unanswered_question: t.mentor.attention.unansweredQuestion,
    pending_meeting: t.mentor.attention.pendingMeeting,
    no_open_goal: t.mentor.attention.noOpenGoal,
    missing_weekly_reports: t.weeklyReports.missingAttention,
    stage_stalled: h.stageStalled,
  };

  // "Message the mentor" opens the DM itself — the same create-or-get flow the
  // profile quick actions use — so the action is one click, not a page to
  // find a button on. The mentor's profile is the fallback if that fails.
  const messageMentor = async (row: Row, fallback: string) => {
    setOpening(row.relationId);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: row.mentor.id }),
      });
      const body = await res.json().catch(() => ({}));
      router.push(res.ok && body.conversation?.id ? `/messages/c/${body.conversation.id}` : fallback);
    } catch {
      router.push(fallback);
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const counters: { key: HealthBand; label: string }[] = [
    { key: 'AT_RISK', label: h.atRisk },
    { key: 'WATCH', label: h.watch },
    { key: 'HEALTHY', label: h.healthy },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
          <HeartPulse className="h-6 w-6 text-red-500" /> {h.title}
        </h1>
        <p className="text-gray-500 mt-1 max-w-3xl">{h.subtitle}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6" data-testid="health-counters">
        {counters.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setBand(band === c.key ? '' : c.key)}
            data-testid={`health-count-${c.key}`}
            aria-pressed={band === c.key}
            className={`rounded-2xl border bg-white dark:bg-gray-900 p-4 text-left transition-colors ${band === c.key ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-200 dark:border-gray-800'}`}
          >
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{data?.counts[c.key] ?? '—'}</p>
          </button>
        ))}
        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4" data-testid="health-count-crossed7">
          <p className="text-xs text-gray-500">{h.crossed7}</p>
          <p className="text-2xl font-bold text-red-600">{data?.counts.crossed7 ?? '—'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
        <Select
          label={h.filterBand}
          data-testid="health-filter-band"
          value={band}
          onChange={(e) => setBand(e.target.value)}
          options={[{ value: '', label: h.all }, ...counters.map((c) => ({ value: c.key, label: c.label }))]}
        />
        <Select
          label={h.filterMentor}
          data-testid="health-filter-mentor"
          value={mentorId}
          onChange={(e) => setMentorId(e.target.value)}
          options={[{ value: '', label: h.all }, ...(data?.filters.mentors ?? []).map((m) => ({ value: m.id, label: m.name }))]}
        />
        <Select
          label={h.filterCohort}
          data-testid="health-filter-cohort"
          value={cohortId}
          onChange={(e) => setCohortId(e.target.value)}
          options={[{ value: '', label: h.all }, ...(data?.filters.cohorts ?? []).map((c) => ({ value: c.id, label: c.name }))]}
        />
        <Select
          label={h.filterStage}
          data-testid="health-filter-stage"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          options={[{ value: '', label: h.all }, ...(data?.filters.stages ?? []).map((s) => ({ value: s.key, label: s.label }))]}
        />
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {loading && !data ? (
        <div className="text-center py-12 text-gray-400" data-testid="page-loading">{t.common.loading}</div>
      ) : !data || data.rows.length === 0 ? (
        <div data-testid="health-empty" className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-10 text-center text-gray-400">
          {h.empty}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <table className="w-full text-sm" data-testid="health-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500">
                <th className="px-4 py-3 font-medium">{h.colPair}</th>
                <th className="px-4 py-3 font-medium">{h.colScore}</th>
                <th className="px-4 py-3 font-medium">{h.colTrend}</th>
                <th className="px-4 py-3 font-medium">{h.colReasons}</th>
                <th className="px-4 py-3 font-medium">{h.colAction}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.relationId} data-testid={`health-row-${row.relationId}`} className="border-b border-gray-100 dark:border-gray-800/60 last:border-0 align-top">
                  <td className="px-4 py-3">
                    <Link href={`/admin/candidates/${row.mentee.id}`} className="font-medium text-gray-900 dark:text-gray-100 hover:underline">
                      {row.mentee.name}
                    </Link>
                    <div className="text-xs text-gray-500">
                      {h.withMentor.replace('{mentor}', row.mentor.name)} · {row.stage.label}
                      {row.cohort ? ` · ${row.cohort.name}` : ''}
                    </div>
                    {row.daysSinceLastInteraction !== null && row.reasons.includes('inactive') && (
                      <div className="text-xs text-gray-400">{t.mentor.attention.daysAgo.replace('{d}', String(row.daysSinceLastInteraction))}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge variant={BAND_VARIANT[row.band]} data-testid={`health-band-${row.relationId}`}>
                      {row.band === 'AT_RISK' ? h.atRisk : row.band === 'WATCH' ? h.watch : h.healthy}
                    </Badge>
                    <span className="ml-2 font-semibold text-gray-900 dark:text-gray-100" data-testid={`health-score-${row.relationId}`}>
                      {row.score ?? h.noScore}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {row.series.length === 0 ? (
                      <span className="text-xs text-gray-400">{h.trendNone}</span>
                    ) : (
                      <div>
                        {/* The product's CSS bars, one per measured day — no chart library. */}
                        <div className="flex items-end gap-px h-8 w-32" aria-hidden="true">
                          {row.series.map((p) => (
                            <div
                              key={p.day}
                              title={`${p.day}: ${p.score ?? '—'}`}
                              className={`flex-1 min-w-[2px] rounded-sm ${BAND_BAR[p.band]}`}
                              style={{ height: `${Math.max(p.score ?? 0, 4)}%` }}
                            />
                          ))}
                        </div>
                        {row.trend30 !== null && (
                          <p className="text-xs text-gray-500 mt-1">{h.trendDelta.replace('{d}', `${row.trend30 > 0 ? '+' : ''}${row.trend30}`)}</p>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {row.reasons.map((r) => (
                        <Badge key={r} variant={REASON_VARIANT[r]} className="text-xs">
                          {reasonLabel[r]}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {row.nextAction &&
                      (row.nextAction.kind === 'message_mentor' ? (
                        <button
                          type="button"
                          onClick={() => messageMentor(row, row.nextAction!.href)}
                          disabled={opening === row.relationId}
                          data-testid={`health-action-${row.relationId}`}
                          data-action={row.nextAction.kind}
                          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline disabled:opacity-50"
                        >
                          {h.action.message_mentor} <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <Link
                          href={row.nextAction.href}
                          data-testid={`health-action-${row.relationId}`}
                          data-action={row.nextAction.kind}
                          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
                        >
                          {h.action[row.nextAction.kind]} <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>{h.page.replace('{p}', String(data.page)).replace('{n}', String(pages))}</span>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>{h.prev}</Button>
            <Button type="button" size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>{h.next}</Button>
          </div>
        </div>
      )}

      {data && (
        <div className="mt-3 space-y-0.5 text-xs text-gray-500" data-testid="health-footnote">
          {data.excluded.dormant > 0 && <p data-testid="health-foot-dormant">{h.footDormant.replace('{n}', String(data.excluded.dormant))}</p>}
          {data.excluded.notActive > 0 && <p data-testid="health-foot-not-active">{h.footNotActive.replace('{n}', String(data.excluded.notActive))}</p>}
          {data.excluded.quiet > 0 && <p data-testid="health-foot-quiet">{h.footQuiet.replace('{n}', String(data.excluded.quiet))}</p>}
        </div>
      )}

      <details className="mt-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4" data-testid="health-how">
        <summary className="cursor-pointer font-medium text-gray-900 dark:text-gray-100">{h.howTitle}</summary>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{h.howLead}</p>
        <p className="mt-2 text-sm text-gray-500">{h.howMissing}</p>
        <ul className="mt-3 space-y-1 text-sm">
          {HEALTH_RULES.map((rule) => (
            <li key={rule.key} className="flex gap-3">
              <span className="w-20 shrink-0 font-medium text-gray-900 dark:text-gray-100">{h.weight.replace('{w}', String(rule.weight))}</span>
              <span className="text-gray-600 dark:text-gray-400">{h.rules[rule.key as keyof typeof h.rules]}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          <a href={RULES_DOC_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" data-testid="health-rules-link">
            {h.howLink}
          </a>
          <span className="ml-2 text-xs text-gray-400">{h.howVersion.replace('{v}', String(HEALTH_RULES_VERSION))}</span>
        </p>
      </details>
    </div>
  );
}
