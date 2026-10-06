'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { PremiumAnalyticsLocked } from '@/components/admin/PremiumAnalyticsLocked';
import { useT, useLocale } from '@/i18n/client';
import { useAdvancedAnalytics } from '@/lib/analyticsEntitlementsClient';
import { formatMinor, type RoiAssumptions, type RoiResult, type RoiStep } from '@/lib/roi';

// Programme ROI (#1895): the number, then every step that produced it, then
// every assumption with its value and why it is there — editable, as query
// state only. One model (src/lib/roi.ts) computes it, shared with the public
// calculator (#1755). Prints to one A4 page (globals.css, #roi-print).
//
// The entitlement is READ first (#1442), so an unentitled admin gets the locked
// panel without a 4xx in the network log; the API keeps its own gate.

interface RoiResponse {
  window: { from: string; to: string };
  cohortId: string | null;
  currency: string | null;
  mentorHours: number;
  defaults: RoiAssumptions;
  cohorts: { id: string; name: string }[];
  result: RoiResult;
  costsByCategory: { category: string; amountMinor: number; lines: number }[];
  costCurrencies: string[];
  placementSources: { ledger: number; stage: number };
  finishedLabel: string;
}

const ASSUMPTIONS: { key: keyof Omit<RoiAssumptions, 'currency'>; label: 'unfilledRoleCostPerMonth' | 'vacancyMonthsAvoided' | 'recruiterFeeAvoided' | 'mentorHourValue'; money: boolean }[] = [
  { key: 'unfilledRoleCostPerMonthMinor', label: 'unfilledRoleCostPerMonth', money: true },
  { key: 'vacancyMonthsAvoidedPerPlacement', label: 'vacancyMonthsAvoided', money: false },
  { key: 'recruiterFeeAvoidedPerPlacementMinor', label: 'recruiterFeeAvoided', money: true },
  { key: 'mentorHourValueMinor', label: 'mentorHourValue', money: true },
];

/** How many minor units make one major unit of `currency` (Intl knows JPY has none). */
function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function RoiPage() {
  const t = useT();
  const locale = useLocale();
  const r = t.roi;
  const s = r.screen;
  const premium = useAdvancedAnalytics();
  const [data, setData] = useState<RoiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    return isoDay(new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate() + 1)));
  });
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [cohortId, setCohortId] = useState('');
  const [currency, setCurrency] = useState('');
  // Assumption edits in MAJOR units as typed (strings), keyed by assumption.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [mentorHours, setMentorHours] = useState('0');

  const resultCurrency = data?.result.ok ? data.result.currency : data?.currency ?? data?.defaults.currency ?? 'EUR';
  const digits = minorDigits(resultCurrency);

  const query = useMemo(() => {
    const params = new URLSearchParams({ from, to });
    if (cohortId) params.set('cohortId', cohortId);
    if (currency) params.set('currency', currency);
    for (const a of ASSUMPTIONS) {
      const raw = edits[a.key];
      if (raw === undefined || raw.trim() === '') continue;
      const n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) continue;
      params.set(a.key, String(a.money ? Math.round(n * 10 ** digits) : n));
    }
    const hours = Number(mentorHours.replace(',', '.'));
    if (Number.isFinite(hours) && hours > 0) params.set('mentorHours', String(hours));
    return params.toString();
  }, [from, to, cohortId, currency, edits, mentorHours, digits]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/analytics/roi?${query}`);
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
    } catch {
      setError(t.common.error);
    } finally {
      setLoading(false);
    }
  }, [query, t.common.error]);

  useEffect(() => {
    if (premium !== true) return;
    // Debounced: typing an assumption should recalculate once, not per key.
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
  }, [premium, load]);

  if (premium === null) return <p className="text-center py-12 text-gray-400" data-testid="page-loading">{t.common.loading}</p>;
  if (premium === false) {
    return (
      <div className="max-w-xl" data-testid="roi-locked">
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline mb-4">
          <ArrowLeft className="h-4 w-4" /> {s.back}
        </Link>
        <PremiumAnalyticsLocked title={r.title} />
      </div>
    );
  }

  const money = (minor: number | null) => (minor === null ? '—' : formatMinor(minor, resultCurrency, locale));
  const stepValue = (step: RoiStep) =>
    step.key === 'roiPercent'
      ? step.percent === null || step.percent === undefined ? '—' : `${step.percent}%`
      : step.key === 'placements'
        ? String(step.count ?? 0)
        : money(step.valueMinor);
  const result = data?.result;
  const categoryLabel = (key: string) => (r.categories as Record<string, string>)[key] ?? key;
  const majorOf = (minor: number) => (minor / 10 ** digits).toString();

  return (
    <div id="roi-print" className="max-w-5xl">
      <div className="no-print mb-4">
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {s.back}
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{r.title}</h1>
          <p className="text-gray-500 mt-1">{r.subtitle}</p>
          {data && <p className="text-xs text-gray-400 mt-1" data-testid="roi-window">{data.window.from} – {data.window.to}</p>}
        </div>
        <Button variant="outline" size="sm" className="no-print" onClick={() => window.print()} data-testid="roi-print-button">
          <Printer className="mr-1 h-4 w-4" /> {s.print}
        </Button>
      </div>

      <div className="no-print grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{s.from}</span>
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} data-testid="roi-from" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{s.to}</span>
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} data-testid="roi-to" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <Select
          label={s.cohort}
          data-testid="roi-cohort"
          value={cohortId}
          onChange={(e) => setCohortId(e.target.value)}
          options={[{ value: '', label: s.allCohorts }, ...(data?.cohorts ?? []).map((c) => ({ value: c.id, label: c.name }))]}
        />
        {(data?.costCurrencies.length ?? 0) > 1 && (
          <Select
            label={s.currency}
            data-testid="roi-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            options={[{ value: '', label: '—' }, ...(data?.costCurrencies ?? []).map((c) => ({ value: c, label: c }))]}
          />
        )}
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {loading && !data && <p className="text-center py-12 text-gray-400" data-testid="page-loading">{t.common.loading}</p>}

      {result && !result.ok && (
        <p className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" data-testid="roi-error">
          {result.error === 'mixed_currency' ? `${r.errors.mixedCurrency} (${result.currencies.join(', ')})` : result.error === 'invalid_currency' ? r.errors.invalidCurrency : r.errors.invalidAmount}
        </p>
      )}

      {result?.ok && data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <div className="col-span-2 lg:col-span-1 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
              <p className="text-xs text-gray-500">{s.headline}</p>
              <p className="text-3xl font-bold text-gray-900 dark:text-gray-100" data-testid="roi-percent">
                {result.roiPercent === null ? '—' : `${result.roiPercent}%`}
              </p>
              {result.roiPercent === null && <p className="text-xs text-gray-500 mt-1">{s.noRoi}</p>}
            </div>
            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
              <p className="text-xs text-gray-500">{s.net}</p>
              <p className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="roi-net">{money(result.netMinor)}</p>
            </div>
            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
              <p className="text-xs text-gray-500">{s.costPerPlacement}</p>
              <p className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="roi-cost-per-placement">{money(result.costPerPlacementMinor)}</p>
            </div>
            <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
              <p className="text-xs text-gray-500">{s.placements}</p>
              <p className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="roi-placements">{result.placementCount}</p>
            </div>
          </div>

          {result.assumedPlacements > 0 && (
            <p className="mb-4 text-sm text-amber-700" data-testid="roi-estimate-warning">{r.estimateWarning}</p>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
            <section className="lg:col-span-3 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 break-inside-avoid">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">{r.workingTitle}</h2>
              <p className="text-xs text-gray-500 mb-3">{r.workingIntro}</p>
              <table className="w-full text-sm" data-testid="roi-steps">
                <tbody>
                  {result.steps.map((step) => (
                    <tr key={step.key} data-testid={`roi-step-${step.key}`} className="border-b border-gray-100 dark:border-gray-800 last:border-0 align-top">
                      <td className="py-1.5 pr-3 text-gray-700 dark:text-gray-300">{r.steps[step.key]}</td>
                      <td className="py-1.5 pr-3 text-right font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">{stepValue(step)}</td>
                      <td className="py-1.5 font-mono text-[11px] text-gray-400 break-all">{step.expression}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-gray-500" data-testid="roi-placements-note">
                {s.placementsNote
                  .replace('{n}', String(data.placementSources.ledger + data.placementSources.stage))
                  .replace('{ledger}', String(data.placementSources.ledger))
                  .replace('{stage}', String(data.placementSources.stage))
                  .replace('{stage_label}', data.finishedLabel)}
              </p>
            </section>

            <section className="lg:col-span-2 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 break-inside-avoid">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-3">{s.costsTitle}</h2>
              {data.costsByCategory.length === 0 ? (
                <p className="text-sm text-gray-500" data-testid="roi-no-costs">{r.noCosts}</p>
              ) : (
                <table className="w-full text-sm" data-testid="roi-costs">
                  <tbody>
                    {data.costsByCategory.map((g) => (
                      <tr key={g.category} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <td className="py-1.5 pr-3 text-gray-700 dark:text-gray-300">{categoryLabel(g.category)}</td>
                        <td className="py-1.5 text-right font-medium text-gray-900 dark:text-gray-100">{money(g.amountMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-3 text-xs text-gray-500">{s.costsOverlapNote}</p>
            </section>
          </div>
        </>
      )}

      {data && (
        <section className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 break-inside-avoid" data-testid="roi-assumptions">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">{r.assumptions.title}</h2>
              <p className="text-xs text-gray-500">{r.assumptions.intro}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="no-print"
              data-testid="roi-reset"
              onClick={() => {
                setEdits({});
                setMentorHours('0');
              }}
            >
              {s.reset}
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ASSUMPTIONS.map((a) => {
              const def = data.defaults[a.key];
              const shownDefault = a.money ? formatMinor(def, resultCurrency, locale) : String(def);
              const current = result?.ok ? result.assumptions[a.key] : def;
              return (
                <label key={a.key} className="block text-sm">
                  <span className="block font-medium text-gray-700 dark:text-gray-300">{r.assumptions[a.label]}</span>
                  <span className="block text-xs text-gray-500 mb-1">{s.hints[a.label]}</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="number"
                      step="any"
                      min={0}
                      inputMode="decimal"
                      value={edits[a.key] ?? (a.money ? majorOf(current as number) : String(current))}
                      onChange={(e) => setEdits({ ...edits, [a.key]: e.target.value })}
                      data-testid={`roi-assumption-${a.key}`}
                      className="w-36 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
                    />
                    <span className="text-xs text-gray-400">{a.money ? resultCurrency : ''} · {s.defaultValue.replace('{v}', shownDefault)}</span>
                  </span>
                </label>
              );
            })}
            <label className="block text-sm">
              <span className="block font-medium text-gray-700 dark:text-gray-300">{s.mentorHours}</span>
              <span className="block text-xs text-gray-500 mb-1">{s.hints.mentorHours}</span>
              <input
                type="number"
                step="any"
                min={0}
                inputMode="decimal"
                value={mentorHours}
                onChange={(e) => setMentorHours(e.target.value)}
                data-testid="roi-mentor-hours"
                className="w-36 rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-gray-500 no-print">{s.editNote}</p>
          <p className="mt-1 text-xs text-gray-500">{s.deterministic}</p>
        </section>
      )}
    </div>
  );
}

