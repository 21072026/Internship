'use client';

import { ProgramScorecard } from '@/components/admin/ProgramScorecard';
import { AnalyticsNarrative } from '@/components/analytics/AnalyticsNarrative';
import { MeetingAttendanceCard } from '@/components/admin/MeetingAttendanceCard';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { useResolvedStages, useStageLabel } from '@/lib/pipelineStagesClient';
import { CohortComparison } from '@/components/admin/CohortComparison';
import { PremiumAnalyticsLocked } from '@/components/admin/PremiumAnalyticsLocked';
import { ProgramBenchmark } from '@/components/admin/ProgramBenchmark';
import { SourceConversion } from '@/components/admin/SourceConversion';
import { MatchQuality } from '@/components/admin/MatchQuality';
import { TrialConversionCard, type TrialConversionData } from '@/components/admin/TrialConversionCard';
import { DealValueCard } from '@/components/admin/DealValueCard';
import { BarChart, LineChart } from '@/components/charts';
import { useT } from '@/i18n/client';
import { useAnalyticsEntitlements } from '@/lib/analyticsEntitlementsClient';
import { UNSPECIFIED_REASON } from '@/lib/dropoffReasons';
import { PersonHoverCard } from '@/components/PersonHoverCard';
import type { VerticalCapability } from '@/lib/verticals';
import { DEFAULT_MIN_COHORT } from '@/lib/reports/definitions';

interface Analytics {
  funnel: Record<string, number>;
  totalRelations: number;
  conversionToHired: number;
  mentorWorkload: { id: string; fullName: string; active: number; hired: number }[];
  projectWorkload: { name: string; interns: number }[];
  engagement: { interactions: number; meetings: number };
  rsvp: { ACCEPTED?: number; DECLINED?: number; PENDING?: number; responded?: number; acceptanceRate: number | null };
  trends?: { months: string[]; newRelations: number[]; interactions: number[] };
  range?: { from: string; to: string };
  signupFunnel?: {
    days: number;
    registered: number;
    verified: number;
    active: number;
    verifiedRate: number | null;
    activeRate: number | null;
    warn: boolean;
  }[];
  // What this tenant calls the stage the conversion number counted (#1882).
  // `finishedLabelIsCustom` is false when the tenant never renamed it, and the
  // screen then keeps its own translated wording.
  finishedLabel?: string;
  finishedLabelIsCustom?: boolean;
  // The tenant's module set (#2423), resolved server-side through the same
  // shellCapabilities() path the sidebar and the write gate use. A card that
  // describes a module this vertical does not carry is not rendered. Missing
  // from an older server's payload → everything is shown, the same fail-open
  // direction as the shell gate.
  capabilities?: VerticalCapability[];
}

type RangePreset = '30' | '90' | '6m' | '12m' | 'all';

// Turn a preset into a from/to query string. "All time" sends no bounds so the
// API falls back to its default (which then reports the widest sensible window).
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

interface AgingItem {
  relationId: string;
  menteeId: string;
  menteeName: string;
  pipelineStatus: string;
  daysInStage: number;
  overdue: boolean;
}
interface DropReason {
  pipelineStatus: string;
  reasonCode: string;
  count: number;
}
interface Aging {
  stageAging: { pipelineStatus: string; visits: number; candidates: number; avgDays: number; medianDays: number }[];
  oldestStuck: AgingItem[];
  overdue: AgingItem[];
  overdueCount: number;
  dropReasons: DropReason[];
  // False when the org's vertical lacks `mentorship`: the per-candidate lists
  // were withheld server-side, so the panel is not drawn (leak audit WP3).
  candidateLists?: boolean;
}

function Stat({ label, value, testId }: { label: string; value: string | number; testId?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4" data-testid={testId}>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}

interface FunnelKpi {
  order: string[];
  conversions: { key: string; entered: number; advanced: number; rate: number | null; terminal: boolean }[];
  biggestDropOff: { key: string; entered: number; advanced: number; rate: number | null } | null;
  timeToHire: {
    completionKey: string | null;
    completed: number;
    considered: number;
    medianDays: number | null;
    avgDays: number | null;
  };
  capacity: {
    id: string;
    fullName: string;
    activeMenteeCount: number;
    mentorCapacity: number | null;
    status: string;
    capacityKnown: boolean;
    overloaded: boolean;
  }[];
  // Cohorts (#2420 / #2425). `rate`, `churned` and `rate` again are null where
  // there is no number to state — an empty month, a retention window that has
  // not closed yet — and every one of them renders as an em dash rather than
  // as 0%, which would be a claim.
  cohortConversion: {
    fromKey: string;
    toKey: string | null;
    months: { month: string; entered: number; converted: number; rate: number | null }[];
  };
  retention: {
    // Keys only. The stage's NAME comes from `useStageLabel()` below, which
    // carries the tenant's own labels in the reader's language (#2268); a label
    // resolved server-side without a locale would be English for everyone.
    wonKeys: string[];
    buckets: number[];
    cohorts: {
      month: string;
      won: number;
      buckets: { months: number; churned: number | null; rate: number | null }[];
    }[];
  };
  // Trial → paid (#2556). Null for a tenant with no trial stage — the card is
  // then not drawn at all. `rate` is null for an empty OR immature month;
  // `bySource` is null while the premium tier is off.
  trialConversion?: TrialConversionData | null;
  journeys: number;
}

export default function AdminAnalyticsPage() {
  const t = useT();
  const label = useStageLabel();
  const stages = useResolvedStages();
  const [data, setData] = useState<Analytics | null>(null);
  const [aging, setAging] = useState<Aging | null>(null);
  // Funnel KPIs (#815): conversion, time-to-hire and mentor capacity.
  const [kpi, setKpi] = useState<FunnelKpi | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangePreset>('6m');
  // Premium tier state (#540): drives the full-report export buttons and the
  // three premium report cards. Read from `/api/admin/analytics/entitlements` —
  // one request that answers the question, where this used to probe the gated
  // cohorts endpoint and infer the tier from a 403 (#1442). `null` = not known
  // yet, so neither the premium cards nor the locked panel is drawn.
  const entitlements = useAnalyticsEntitlements();
  const premium = entitlements === null ? null : entitlements.advancedAnalytics;
  // REPORT_EXPORT (#1740): the export buttons reflect it; the export route enforces it.
  const canExport = entitlements?.reportExport === true;

  // The word this screen uses for "reached the outcome". A tenant that renamed
  // its last pipeline stage gets ITS name; everyone else keeps the translated
  // strings that were here before #1882, so a default-catalogue tenant sees
  // exactly the same text as before.
  const outcomeName = data?.finishedLabelIsCustom ? data.finishedLabel : undefined;
  const outcomeWord = outcomeName ?? t.analytics.hired;
  const conversionLabel = outcomeName
    ? t.analytics.conversionToStage.replace('{stage}', outcomeName)
    : t.analytics.conversion;

  // Module gate (#2423). INTERNSHIP carries every capability, so for it every
  // card below renders exactly as before. A MARKETING org has no mentors, no
  // meetings with an RSVP, no self-service sign-up door and no intern
  // projects — the cards about those would only ever show zeros and empty
  // states, so they are not drawn. Mentor CAPACITY needs no check here: the
  // funnel route returns an empty list for such a tenant, which the section
  // and the export already read as "nothing to show".
  const has = (capability: VerticalCapability) => !data?.capabilities || data.capabilities.includes(capability);
  const showMentorship = has('mentorship');
  const showProjects = has('projects');

  useEffect(() => {
    const qs = rangeQuery(range);
    setLoading(true);
    setError(null);
    fetch(`/api/admin/analytics${qs}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => setData(d))
      .catch((e) => { console.error('[analytics]', e); setError(t.common.error); })
      .finally(() => setLoading(false));
    fetch(`/api/admin/analytics/aging${qs}`)
      // A refused or failed read leaves the cards out rather than rendering an
      // error body as if it were the report.
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAging(d))
      .catch((e) => console.error('[analytics/aging]', e));
    fetch(`/api/admin/analytics/funnel${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setKpi(d))
      .catch((e) => console.error('[analytics/funnel]', e));
  }, [range, t.common.error]);

  const maxFunnel = data ? Math.max(1, ...stages.map((s) => data.funnel[s.key] || 0)) : 1;

  // Drop-off reason label (#810), falling back to the raw code for anything
  // outside the current whitelist (defensive — should not normally happen).
  const reasonLabel = (code: string) => (t.dropoff.reasons as Record<string, string>)[code] ?? code;
  // The workbooks come from the export route (#1740) as finished sheets — rows
  // and localized labels built server-side (src/lib/reports/workbooks.ts,
  // #1903), gated by the org's REPORT_EXPORT entitlement (the full report also
  // by ADVANCED_ANALYTICS). This screen only writes the file.
  const exportWorkbook = async (dataset: 'analytics' | 'analytics-full') => {
    const res = await fetch(`/api/admin/export/${dataset}${rangeQuery(range)}`);
    if (!res.ok) {
      setError(res.status === 403 ? t.common.exportLocked : t.common.error);
      return;
    }
    const { sheets } = await res.json();
    const { exportXlsxSheets } = await import('@/lib/excel');
    await exportXlsxSheets(`${dataset}-${new Date().toISOString().slice(0, 10)}`, sheets);
  };
  const exportExcel = () => exportWorkbook('analytics');
  // Premium full-report Excel (#540): funnel, KPIs, trends, mentor workload
  // and the cohort/source reports — the latter two behind the privacy floor.
  const exportFullExcel = () => exportWorkbook('analytics-full');

  return (
    <div>
      <div className="mb-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.analytics.title}</h1>
          <p className="text-gray-500 mt-1">{t.analytics.subtitle}</p>
        </div>
        {/* Up to five controls: on a phone (and in German, where the labels are
            longest) they have to wrap, or the row pushed the whole page 51px
            wider than the screen (#1305). */}
        <div className="flex flex-wrap items-center gap-2 no-print">
          <Select
            aria-label={t.analytics.dateRange}
            className="w-auto"
            value={range}
            onChange={(e) => setRange(e.target.value as RangePreset)}
            options={[
              { value: '30', label: t.analytics.last30 },
              { value: '90', label: t.analytics.last90 },
              { value: '6m', label: t.analytics.last6m },
              { value: '12m', label: t.analytics.last12m },
              { value: 'all', label: t.analytics.allTime },
            ]}
          />
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={!data || !canExport} title={entitlements && !canExport ? t.common.exportLocked : undefined}>{t.analytics.exportExcel}</Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>{t.analytics.print}</Button>
          {/* First destination (#1912) is a compliance report, not an upsell. */}
          <Link href="/admin/analytics/outcomes" className="inline-flex items-center px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors" data-testid="outcomes-link">
            {t.outcomes.link}
          </Link>
          {premium && (
            <>
              <Button variant="outline" size="sm" onClick={exportFullExcel} disabled={!data || !canExport} title={entitlements && !canExport ? t.common.exportLocked : undefined} data-testid="full-report-excel">{t.analytics.fullReportExcel}</Button>
              <Link href="/admin/analytics/report" className="inline-flex items-center px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors" data-testid="full-report-link">
                {t.analytics.fullReport}
              </Link>
              <Link href="/admin/analytics/roi" className="inline-flex items-center px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors" data-testid="roi-link">
                {t.roi.screen.openFromAnalytics}
              </Link>
              <Link href="/admin/analytics/executive" className="inline-flex items-center px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors" data-testid="executive-link">
                {t.executive.openFromAnalytics}
              </Link>
              <Link href="/admin/reports/subscriptions" className="inline-flex items-center px-3 py-1.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors" data-testid="schedule-reports-link">
                {t.reportSubscriptions.ui.openFromAnalytics}
              </Link>
            </>
          )}
        </div>
      </div>

      {/* "Is this programme healthy?" (#1908) — the verdict first, the detail below. */}
      <ProgramScorecard />

      {/* "What changed" (#2046): AI prose grounded only in the figures below. */}
      <AnalyticsNarrative query={rangeQuery(range)} />
      {/* Who actually met, and on the promised rhythm (#2014). */}
      <MeetingAttendanceCard />

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400" data-testid="page-loading">{t.common.loading}</div>
      ) : !data ? (
        <div className="text-center py-12 text-gray-400">{t.common.notFound}</div>
      ) : (
        <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label={t.analytics.totalRelations} value={data.totalRelations} />
        <Stat label={conversionLabel} value={`${data.conversionToHired}%`} testId="headline-conversion" />
        <Stat label={t.analytics.interactions} value={data.engagement.interactions} />
        {showMentorship && (
          <Stat label={t.analytics.rsvpRate} value={data.rsvp.acceptanceRate === null ? '—' : `${data.rsvp.acceptanceRate}%`} testId="headline-rsvp" />
        )}
      </div>

      {/* Signup funnel (#1191): registered → verified → active for the last 7
          and 30 days. Its job is to expose a SILENT failure — if verification
          mail stops arriving, everything else still looks fine. Rates are
          computed live; a window with no sign-ups shows "—" and never warns.
          Mentorship-only (#2423): the door it watches is the candidates' own
          sign-up; a marketing tenant's team arrives by invitation. */}
      {showMentorship && data.signupFunnel && data.signupFunnel.length > 0 && (
        <Card className="mb-6" data-testid="signup-funnel-card">
          <CardHeader><CardTitle>{t.analytics.signupFunnel.title}</CardTitle></CardHeader>
          <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t.analytics.signupFunnel.hint}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {data.signupFunnel.map((w) => (
              <div
                key={w.days}
                data-testid={`signup-funnel-${w.days}`}
                className={`rounded-xl border p-4 ${
                  w.warn ? 'border-amber-300 bg-amber-50 dark:bg-amber-900/20' : 'border-gray-100 dark:border-gray-800'
                }`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  {t.analytics.signupFunnel.lastDays.replace('{n}', String(w.days))}
                </p>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="text-gray-700 dark:text-gray-300">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{w.registered}</span>{' '}
                    {t.analytics.signupFunnel.registered}
                  </span>
                  <span className="text-gray-400">→</span>
                  <span className="text-gray-700 dark:text-gray-300">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{w.verified}</span>{' '}
                    {t.analytics.signupFunnel.verified}
                  </span>
                  <span className="text-gray-400">→</span>
                  <span className="text-gray-700 dark:text-gray-300">
                    <span className="font-semibold text-gray-900 dark:text-gray-100">{w.active}</span>{' '}
                    {t.analytics.signupFunnel.active}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-gray-500" data-testid={`signup-funnel-rates-${w.days}`}>
                  {t.analytics.signupFunnel.verifiedRate}:{' '}
                  <span className={w.warn ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300'}>
                    {w.verifiedRate === null ? '—' : `${w.verifiedRate}%`}
                  </span>
                  {' · '}
                  {t.analytics.signupFunnel.activeRate}:{' '}
                  <span className="text-gray-700 dark:text-gray-300">{w.activeRate === null ? '—' : `${w.activeRate}%`}</span>
                </p>
                {w.warn && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300" data-testid={`signup-funnel-warning-${w.days}`}>
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                      {t.analytics.signupFunnel.warning}{' '}
                      <Link href="/admin/settings#email" className="underline hover:text-amber-900">
                        {t.analytics.signupFunnel.warningCta}
                      </Link>
                    </span>
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Funnel KPIs (#815): the ratios, next to the counts they come from. */}
      {kpi && (
        <Card className="mb-6" data-testid="funnel-kpi-card">
          <CardHeader><CardTitle>{t.analytics.funnelKpi.title}</CardTitle></CardHeader>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.analytics.funnelKpi.conversion}</p>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">{t.analytics.funnelKpi.conversionHint}</p>
              <div className="space-y-1.5" data-testid="conversion-list">
                {kpi.conversions.map((c) => (
                  /* Four fixed columns (176 + 96 + 112 + gaps = 408px) in a
                     278px box is a 130px spill at 360px — #1485, and the German
                     stage labels are what made it visible. A phone gets two
                     rows instead: label + rate above, bar + count below, which
                     keeps every number rather than hiding the denominator.
                     From `sm:` up it is the original single flex row, so the
                     desktop layout is unchanged — hence the `sm:order-*`, since
                     the DOM order the grid needs (label, rate, bar, count) is
                     not the order the row reads in (label, bar, rate, count). */
                  <div
                    key={c.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-sm sm:flex sm:gap-y-0"
                  >
                    <span className="min-w-0 truncate text-gray-600 dark:text-gray-400 sm:order-1 sm:w-44 sm:flex-shrink-0">{label(c.key)}</span>
                    <span className="w-16 text-right text-gray-700 dark:text-gray-300 sm:order-3 sm:w-24 sm:flex-shrink-0" data-testid={`conversion-${c.key}`}>
                      {/* No rate to show in two cases: nobody reached the stage
                          (0% would claim they all dropped out of it), and the
                          last stage (where "did not advance" means finished). */}
                      {c.rate === null ? (c.terminal ? '—' : t.analytics.funnelKpi.noData) : `${c.rate}%`}
                    </span>
                    <div className="min-w-0 bg-gray-100 dark:bg-gray-800 rounded h-4 overflow-hidden sm:order-2 sm:flex-1">
                      <div
                        className={`h-full ${kpi.biggestDropOff?.key === c.key ? 'bg-red-500' : 'bg-emerald-500'}`}
                        style={{ width: `${c.rate ?? 0}%` }}
                      />
                    </div>
                    <span className="w-24 text-right text-xs text-gray-400 sm:order-4 sm:w-28 sm:flex-shrink-0">
                      {c.entered} {t.analytics.funnelKpi.entered}
                    </span>
                  </div>
                ))}
              </div>
              {kpi.biggestDropOff && (
                <p className="mt-3 text-xs text-red-700 dark:text-red-400">
                  {t.analytics.funnelKpi.biggestDropOff}: {label(kpi.biggestDropOff.key)} (
                  {kpi.biggestDropOff.entered - kpi.biggestDropOff.advanced})
                </p>
              )}
            </div>

            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t.analytics.funnelKpi.timeToHire.replace(
                  '{stage}',
                  kpi.timeToHire.completionKey ? label(kpi.timeToHire.completionKey) : '—'
                )}
              </p>
              {kpi.timeToHire.completed === 0 ? (
                <p className="mt-2 text-sm text-gray-500" data-testid="tth-empty">{t.analytics.funnelKpi.noCompleted}</p>
              ) : (
                <>
                  <div className="mt-2 flex items-baseline gap-4">
                    <div>
                      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="tth-median">
                        {kpi.timeToHire.medianDays}
                      </p>
                      <p className="text-xs text-gray-500">
                        {t.analytics.funnelKpi.timeToHireMedian} · {t.analytics.funnelKpi.days}
                      </p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gray-500" data-testid="tth-avg">{kpi.timeToHire.avgDays}</p>
                      <p className="text-xs text-gray-500">
                        {t.analytics.funnelKpi.timeToHireAvg} · {t.analytics.funnelKpi.days}
                      </p>
                    </div>
                  </div>
                  {/* Right-censoring, said out loud: the screen names the
                      population these two numbers describe. */}
                  <p className="mt-3 text-xs text-gray-500" data-testid="tth-population">
                    {t.analytics.funnelKpi.population
                      .replace('{completed}', String(kpi.timeToHire.completed))
                      .replace('{considered}', String(kpi.timeToHire.considered))}
                  </p>
                </>
              )}
            </div>
          </div>

          {kpi.capacity.length > 0 && (
            <div className="mt-6 border-t border-gray-100 dark:border-gray-800 pt-4">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t.analytics.funnelKpi.capacity}</p>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">{t.analytics.funnelKpi.capacityHint}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th className="py-1.5 pr-3">{t.analytics.funnelKpi.mentor}</th>
                      <th className="py-1.5 pr-3">{t.analytics.funnelKpi.activeMentees}</th>
                      <th className="py-1.5 pr-3">{t.analytics.funnelKpi.ceiling}</th>
                      <th className="py-1.5"> </th>
                    </tr>
                  </thead>
                  <tbody data-testid="capacity-table">
                    {kpi.capacity.map((m) => (
                      <tr key={m.id} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="py-1.5 pr-3 text-gray-700 dark:text-gray-300">{m.fullName}</td>
                        <td className="py-1.5 pr-3 text-gray-900 dark:text-gray-100">{m.activeMenteeCount}</td>
                        <td className="py-1.5 pr-3 text-gray-500">
                          {m.capacityKnown ? m.mentorCapacity : t.analytics.funnelKpi.noCeiling}
                        </td>
                        <td className="py-1.5">
                          {m.overloaded && (
                            <span className="text-xs text-red-700 dark:text-red-400" data-testid={`overloaded-${m.id}`}>
                              {t.analytics.funnelKpi.overloaded}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Cohorts (#2420 / #2425): conversion grouped by the month a record
          entered, and retention after the won stage. Both are month tables
          rather than bars — the interesting cell is the one that is EMPTY, and
          a bar chart has no way to draw "not known yet". */}
      {kpi?.cohortConversion && kpi.retention && (
        <Card className="mb-6" data-testid="cohort-kpi-card">
          <CardHeader><CardTitle>{t.analytics.cohortKpi.title}</CardTitle></CardHeader>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t.analytics.cohortKpi.conversion}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">
                {t.analytics.cohortKpi.conversionHint
                  .replace('{from}', label(kpi.cohortConversion.fromKey))
                  .replace('{to}', kpi.cohortConversion.toKey ? label(kpi.cohortConversion.toKey) : '—')}
              </p>
              {kpi.cohortConversion.months.length === 0 ? (
                <p className="text-sm text-gray-500" data-testid="cohort-conversion-empty">
                  {t.analytics.cohortKpi.empty}
                </p>
              ) : (
                <>
                {/* Conversion over the selected window as a line (#1890). A
                    month with no rate to state is a gap in the line, not a
                    drop to zero — the table below still prints it as "—". */}
                <LineChart
                  testId="conversion-trend-chart"
                  className="mb-4"
                  ariaLabel={t.analytics.cohortKpi.conversion}
                  height={140}
                  yMax={100}
                  formatValue={(v) => `${v}%`}
                  categories={kpi.cohortConversion.months.map((m) => m.month.slice(2))}
                  series={[
                    { key: 'rate', label: t.analytics.cohortKpi.rate, color: 'var(--chart-1)', values: kpi.cohortConversion.months.map((m) => m.rate), testIdPrefix: 'conversion-point-' },
                  ]}
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="cohort-conversion-table">
                    <thead className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                      <tr>
                        <th className="py-1.5 pr-3 text-left">{t.analytics.cohortKpi.month}</th>
                        <th className="py-1.5 pr-3 text-right">{t.analytics.cohortKpi.entered}</th>
                        <th className="py-1.5 pr-3 text-right">{t.analytics.cohortKpi.converted}</th>
                        <th className="py-1.5 text-right">{t.analytics.cohortKpi.rate}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kpi.cohortConversion.months.map((m) => (
                        <tr key={m.month} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                          <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-400">{m.month}</td>
                          <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">{m.entered}</td>
                          <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">{m.converted}</td>
                          <td
                            className="py-1.5 text-right font-medium text-gray-900 dark:text-gray-100"
                            data-testid={`cohort-conversion-${m.month}`}
                          >
                            {m.rate === null ? '—' : `${m.rate}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </>
              )}
            </div>

            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t.analytics.cohortKpi.retention.replace(
                  '{stage}',
                  kpi.retention.wonKeys.length > 0 ? label(kpi.retention.wonKeys[0]) : '—'
                )}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">
                {t.analytics.cohortKpi.retentionHint.replace(
                  '{stage}',
                  kpi.retention.wonKeys.length > 0 ? label(kpi.retention.wonKeys[0]) : '—'
                )}
              </p>
              {kpi.retention.cohorts.length === 0 ? (
                <p className="text-sm text-gray-500" data-testid="retention-empty">
                  {t.analytics.cohortKpi.empty}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="retention-table">
                    <thead className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                      <tr>
                        <th className="py-1.5 pr-3 text-left">{t.analytics.cohortKpi.month}</th>
                        <th className="py-1.5 pr-3 text-right">{t.analytics.cohortKpi.won}</th>
                        {kpi.retention.buckets.map((b) => (
                          <th key={b} className="py-1.5 pr-3 text-right">
                            {t.analytics.cohortKpi.bucket.replace('{n}', String(b))}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {kpi.retention.cohorts.map((c) => (
                        <tr key={c.month} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                          <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-400">{c.month}</td>
                          <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">{c.won}</td>
                          {c.buckets.map((b) => (
                            <td
                              key={b.months}
                              className="py-1.5 pr-3 text-right text-gray-900 dark:text-gray-100"
                              data-testid={`retention-${c.month}-${b.months}`}
                            >
                              {/* An open window is NOT 0% churn — the cohort
                                  has not had the chance to leave yet. */}
                              {b.rate === null ? '—' : `${b.rate}%`}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-gray-400">{t.analytics.cohortKpi.legend}</p>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Trial → paid (#2556) — only for a tenant whose stage set has a trial
          stage; the route returns null for everyone else. */}
      {kpi?.trialConversion && <TrialConversionCard data={kpi.trialConversion} />}

      {/* The estimated value of won deals (#2422) — MARKETING only: the route
          answers `enabled: false` for any other vertical and the card then
          draws nothing, so INTERNSHIP's page is unchanged. */}
      <DealValueCard query={rangeQuery(range)} />

      {/* One column when the mentor card is not drawn (#2423), so the funnel
          does not sit next to an empty half of the row. */}
      <div className={`grid grid-cols-1 gap-6${showMentorship ? ' lg:grid-cols-2' : ''}`}>
        <Card data-testid="pipeline-funnel-card">
          <CardHeader><CardTitle>{t.analytics.funnel}</CardTitle></CardHeader>
          <div className="space-y-1.5">
            {stages.map((s) => {
              const n = data.funnel[s.key] || 0;
              return (
                <div key={s.key} className="flex items-center gap-2 text-sm">
                  {/* Half the row on a phone, a fixed 192px from `sm` up — the
                      fixed width left the bar a few pixels wide (#1305). */}
                  <span className="w-1/2 sm:w-48 truncate text-gray-600 flex-shrink-0">{s.label}</span>
                  <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                    <div className="bg-blue-500 h-full" style={{ width: `${(n / maxFunnel) * 100}%` }} />
                  </div>
                  <span className="w-8 text-right text-gray-700 flex-shrink-0">{n}</span>
                </div>
              );
            })}
          </div>
        </Card>

        {showMentorship && (
        <Card data-testid="mentor-workload-card">
          <CardHeader><CardTitle>{t.analytics.mentorWorkload}</CardTitle></CardHeader>
          {data.mentorWorkload.length === 0 ? (
            <p className="text-sm text-gray-400">—</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {data.mentorWorkload.map((m) => (
                <div key={m.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate">
                    <PersonHoverCard personId={m.id} name={m.fullName} role="MENTOR" />
                  </span>
                  <span className="text-gray-500 flex-shrink-0">
                    {m.active} {t.analytics.active} · {m.hired} {outcomeWord}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
        )}
      </div>

      {showProjects && data.projectWorkload && data.projectWorkload.length > 0 && (
        <Card className="mt-6" data-testid="projects-card">
          <CardHeader><CardTitle>{t.analytics.projects}</CardTitle></CardHeader>
          <div className="divide-y divide-gray-50">
            {data.projectWorkload.map((p) => (
              <div key={p.name} className="flex items-center justify-between py-2 text-sm">
                <span className="truncate">{p.name}</span>
                <span className="text-gray-500 flex-shrink-0">{p.interns} {t.analytics.interns}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {data.trends && data.trends.months.length > 0 && (
        <Card className="mt-6">
          <CardHeader><CardTitle>{t.analytics.trends}</CardTitle></CardHeader>
          {/* SVG bars sized from a measured width (#1890). The hand-rolled
              track this replaces sized its bars with CSS percentages, which
              only resolve against a DEFINITE parent height — it collapsed to
              0px once (#1425) and needed a pinned pixel row to stay up. */}
          <BarChart
            testId="analytics-trend-chart"
            ariaLabel={t.analytics.trends}
            height={176}
            categories={data.trends.months.map((m) => m.slice(5))}
            series={[
              { key: 'new', label: t.analytics.trendNewRelations, color: 'var(--chart-1)', values: data.trends.newRelations, testIdPrefix: 'trend-bar-new-' },
              { key: 'interactions', label: t.analytics.trendInteractions, color: 'var(--chart-2)', values: data.trends.interactions, testIdPrefix: 'trend-bar-interactions-' },
            ]}
          />
        </Card>
      )}

      {aging && (
        <div className={`grid grid-cols-1 gap-6 mt-6${showMentorship && aging.candidateLists !== false ? ' lg:grid-cols-2' : ''}`}>
          <Card data-testid="stage-aging-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t.analytics.aging.stageAging}
                {aging.overdueCount > 0 && (
                  <Badge variant="danger" className="flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> {aging.overdueCount} {t.analytics.aging.overdue}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            {aging.stageAging.length === 0 ? (
              <p className="text-sm text-gray-400">—</p>
            ) : (
              <>
                {/* Both numbers below are measured from transitions that have
                    ENDED, so neither equals the funnel's "in this stage now" —
                    which is the contradiction this card used to present (#1427).
                    The explanation is rendered, not put in a `title`: a hover
                    tooltip never appears on a touch device, and this page states
                    what its other cards measure the same visible way
                    (funnelKpi.conversionHint). */}
                <p className="text-xs text-gray-500 mt-0.5 mb-3" data-testid="stage-aging-hint">{t.analytics.aging.countsHint}</p>
                <div className="divide-y divide-gray-50 dark:divide-gray-800">
                  {/* The stats string is unbreakable, so on a phone the stage name
                      gets its own line instead of being squeezed to ~35px
                      ("100 · Erstkontakt" → "100 …", #1305). */}
                  {aging.stageAging.map((s) => (
                    <div key={s.pipelineStatus} className="flex flex-col items-start gap-0.5 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-2" data-testid={`stage-aging-row-${s.pipelineStatus}`}>
                      <span className="max-w-full truncate">{label(s.pipelineStatus)}</span>
                      {/* The trailing number used to be printed as "candidates",
                          which flatly contradicted the funnel above: it is the
                          count of completed stage VISITS (a re-entry counts
                          twice), so it read as "6 candidates" where the funnel
                          said 1. Both numbers are now named for what they are
                          (#1427). */}
                      <span className="text-gray-500 sm:flex-shrink-0">
                        {t.analytics.aging.avg} {s.avgDays}{t.analytics.aging.days} · {t.analytics.aging.median} {s.medianDays}{t.analytics.aging.days} · {s.visits} {t.analytics.aging.visits} · {s.candidates} {t.analytics.aging.distinctCandidates}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          {/* "En uzun bekleyen adaylar" names candidates: the internship
              product's panel, withheld server-side for a vertical without
              `mentorship` (the stage numbers beside it stay for everyone). */}
          {showMentorship && aging.candidateLists !== false && (
          <Card data-testid="oldest-stuck-card">
            <CardHeader><CardTitle>{t.analytics.aging.oldestStuck}</CardTitle></CardHeader>
            {aging.oldestStuck.length === 0 ? (
              <p className="text-sm text-gray-400">—</p>
            ) : (
              <div className="divide-y divide-gray-50 dark:divide-gray-800">
                {aging.oldestStuck.map((it) => (
                  <Link
                    key={it.relationId}
                    href={`/admin/candidates/${it.menteeId}`}
                    className="flex items-center justify-between gap-2 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-2 px-2 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="truncate">{it.menteeName}</p>
                      <p className="text-xs text-gray-400 truncate">{label(it.pipelineStatus)}</p>
                    </div>
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      {it.overdue && <AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
                      <span className="text-gray-500">{it.daysInStage}{t.analytics.aging.days}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </Card>
          )}
        </div>
      )}

      {/* Drop-off reasons (#810): stage × reason breakdown for every move onto a
          negative/off-path stage. Pre-existing StatusChange rows with no
          reasonCode are grouped under "Unspecified" rather than dropped. */}
      {aging && (
        <Card className="mt-6" data-testid="drop-reasons-card">
          <CardHeader><CardTitle>{t.analytics.aging.dropReasonsTitle}</CardTitle></CardHeader>
          {aging.dropReasons.length === 0 ? (
            <p className="text-sm text-gray-400">{t.analytics.aging.dropReasonsEmpty}</p>
          ) : (
            <div className="space-y-4">
              {Array.from(new Set(aging.dropReasons.map((d) => d.pipelineStatus))).map((stageKey) => {
                const reasons = aging!.dropReasons
                  .filter((d) => d.pipelineStatus === stageKey)
                  .sort((a, b) => b.count - a.count);
                const total = reasons.reduce((n, r) => n + r.count, 0);
                return (
                  <div key={stageKey}>
                    <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1.5">
                      {label(stageKey)} <span className="text-gray-400 font-normal">({total})</span>
                    </p>
                    <div className="divide-y divide-gray-50 dark:divide-gray-800">
                      {reasons.map((r) => (
                        <div key={r.reasonCode} className="flex items-center justify-between py-1.5 text-sm">
                          <span className={r.reasonCode === UNSPECIFIED_REASON ? 'text-gray-400 italic' : 'text-gray-600 dark:text-gray-300'}>
                            {reasonLabel(r.reasonCode)}
                          </span>
                          <span className="text-gray-500 flex-shrink-0">{r.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* The three premium report cards and their locked state (#1442). All
          three sit behind one gate, so an unentitled tenant gets one panel that
          says so instead of three cards that each learned it from a 403. */}
      {premium === false && <PremiumAnalyticsLocked />}
      {/* Programme cohorts are the internship product; the route refuses a
          vertical without `mentorship` as well (leak audit WP3). */}
      {premium === true && showMentorship && <CohortComparison />}

      {/* Match quality (#2040): how often the mentor suggestion is taken, and
          at which rank position. Not premium-gated — it is the answer to the
          first question every buyer asks about the matching — but it IS about
          mentor suggestions, so a vertical without mentors does not get it
          (#2423). */}
      {showMentorship && <MatchQuality />}

      {premium === true && (
        <>
          <ProgramBenchmark />
          <SourceConversion />
          {/* The privacy floor (#1903): the cards above show every cohort and
              source to the admin, but the exported reports merge small groups
              — say so where the export buttons' output is described. */}
          <p className="mb-6 text-xs text-gray-500 dark:text-gray-400" data-testid="report-floor-footnote">
            {t.reports.exportFootnote.replace('{n}', String(DEFAULT_MIN_COHORT))}
          </p>
        </>
      )}
        </>
      )}
    </div>
  );
}
