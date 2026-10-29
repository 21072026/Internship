'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useLocale, useT } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { DEFAULT_ASSUMPTIONS, PROSPECT_WORKING_WEEKS_DEFAULT, computeRoi, formatMinor, prospectRoiInput } from '@/lib/roi';
import { smallestProgramPlanFor } from '@/lib/plans';

// The public ROI calculator's state and arithmetic (#1755). There is no model
// here: the inputs become a RoiInput through prospectRoiInput() and the figures
// come from computeRoi() — the same function /admin/analytics/roi uses. The
// cost side is the published price of the plan that fits (src/lib/plans.ts).
//
// Fields we have no evidence for start EMPTY (hours, hourly cost, conversion);
// the three with a documented default in src/lib/roi.ts start at it and say so.

type Field =
  | 'internsPerYear'
  | 'admins'
  | 'coordinatorHoursPerWeek'
  | 'coordinatorHourCost'
  | 'costPerHire'
  | 'currentConversion'
  | 'targetConversion'
  | 'workingWeeks'
  | 'unfilledRoleCost'
  | 'vacancyMonths';

const FIELDS: Field[] = [
  'internsPerYear',
  'admins',
  'currentConversion',
  'targetConversion',
  'costPerHire',
  'coordinatorHoursPerWeek',
  'coordinatorHourCost',
  'workingWeeks',
  'unfilledRoleCost',
  'vacancyMonths',
];

const eur = (minor: number) => String(minor / 100);
const DEFAULTS: Record<Field, string> = {
  internsPerYear: '',
  admins: '1',
  coordinatorHoursPerWeek: '',
  coordinatorHourCost: '',
  costPerHire: eur(DEFAULT_ASSUMPTIONS.recruiterFeeAvoidedPerPlacementMinor),
  currentConversion: '',
  targetConversion: '',
  workingWeeks: String(PROSPECT_WORKING_WEEKS_DEFAULT),
  unfilledRoleCost: eur(DEFAULT_ASSUMPTIONS.unfilledRoleCostPerMonthMinor),
  vacancyMonths: String(DEFAULT_ASSUMPTIONS.vacancyMonthsAvoidedPerPlacement),
};

/** A typed number, or null for empty / not a number. A German "12,5" is read as 12.5. */
function num(raw: string): number | null {
  const v = raw.trim().replace(',', '.');
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const minor = (raw: string) => {
  const n = num(raw);
  return n === null ? null : Math.round(n * 100);
};

export function RoiCalculator() {
  const t = useT();
  const locale = useLocale();
  const c = t.roiCalculator;
  const [values, setValues] = useState<Record<Field, string>>(DEFAULTS);
  const money = (m: number) => formatMinor(m, 'EUR', locale);
  const count = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);

  const view = useMemo(() => {
    const interns = num(values.internsPerYear) ?? 0;
    const plan = smallestProgramPlanFor({ activePairs: Math.floor(interns), adminSeats: Math.max(1, Math.floor(num(values.admins) ?? 1)) });
    const annualEur = plan.prices.YEARLY ?? (plan.prices.MONTHLY !== null ? plan.prices.MONTHLY * 12 : 0);
    const prospect = prospectRoiInput({
      internsPerYear: num(values.internsPerYear),
      coordinatorHoursPerWeek: num(values.coordinatorHoursPerWeek),
      coordinatorHourCostMinor: minor(values.coordinatorHourCost),
      costPerHireMinor: minor(values.costPerHire),
      currentConversionPct: num(values.currentConversion),
      targetConversionPct: num(values.targetConversion),
      workingWeeksPerYear: num(values.workingWeeks),
      unfilledRoleCostPerMonthMinor: minor(values.unfilledRoleCost),
      vacancyMonthsAvoided: num(values.vacancyMonths),
      annualPlanCostMinor: annualEur * 100,
    });
    return { plan, annualEur, prospect, result: computeRoi(prospect.input) };
  }, [values]);

  const hintDefault: Partial<Record<Field, string>> = {
    costPerHire: money(DEFAULT_ASSUMPTIONS.recruiterFeeAvoidedPerPlacementMinor),
    workingWeeks: String(PROSPECT_WORKING_WEEKS_DEFAULT),
    unfilledRoleCost: money(DEFAULT_ASSUMPTIONS.unfilledRoleCostPerMonthMinor),
    vacancyMonths: String(DEFAULT_ASSUMPTIONS.vacancyMonthsAvoidedPerPlacement),
  };

  const { plan, prospect, result } = view;
  const ready = !prospect.missing.includes('internsPerYear');

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{c.inputsTitle}</h2>
        <div className="space-y-4">
          {FIELDS.map((f) => (
            <div key={f}>
              <Input
                label={c.fields[f]}
                inputMode="decimal"
                value={values[f]}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                data-testid={`roi-calc-input-${f}`}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{fillTemplate(c.hints[f], { default: hintDefault[f] ?? '' })}</p>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setValues(DEFAULTS)}>{c.reset}</Button>
        </div>
      </Card>

      <div className="space-y-6">
        <Card data-testid="roi-calc-result">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{c.resultTitle}</h2>
          {result.ok && ready ? (
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{c.hoursSaved}</dt>
                <dd className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="roi-calc-hours">{count(prospect.hoursPerYear)}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t.roi.steps.timeSavedValue}</dt>
                <dd className="text-xl font-semibold text-gray-900 dark:text-gray-100">{money(result.timeSavedValueMinor)}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{c.hires}</dt>
                <dd className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="roi-calc-hires">{prospect.hires}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t.roi.steps.assumedValue}</dt>
                <dd className="text-xl font-semibold text-gray-900 dark:text-gray-100">{money(result.assumedValueMinor)}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t.roi.steps.totalCost}</dt>
                <dd className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="roi-calc-cost">{money(result.totalCostMinor)}</dd>
              </div>
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t.roi.steps.net}</dt>
                <dd className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="roi-calc-net">{money(result.netMinor)}</dd>
              </div>
              {result.roiPercent !== null && (
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">{t.roi.steps.roiPercent}</dt>
                  <dd className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="roi-calc-percent">
                    {new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(result.roiPercent / 100)}
                  </dd>
                </div>
              )}
            </dl>
          ) : null}

          <p className="mt-4 text-sm text-gray-700 dark:text-gray-300" data-testid="roi-calc-plan">
            {view.annualEur > 0
              ? fillTemplate(c.planFit, { plan: plan.name, price: money(view.annualEur * 100) })
              : fillTemplate(c.planFree, { plan: plan.name })}{' '}
            <Link href="/pricing" className="text-blue-600 dark:text-blue-400 hover:underline" data-testid="roi-calc-pricing-link">
              {c.seePricing}
            </Link>
          </p>

          {prospect.missing.length > 0 && (
            <div className="mt-4" data-testid="roi-calc-missing">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.missingTitle}</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-gray-600 dark:text-gray-300">
                {prospect.missing.map((m) => <li key={m}>{c.missing[m]}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">{c.freeCore}</p>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{c.formulaTitle}</h2>
          <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700 dark:text-gray-300">
            {c.formula.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{c.yourNumbers}</p>
          {result.ok && ready && (
            <>
              <h3 className="mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100">{t.roi.workingTitle}</h3>
              <table className="mt-2 w-full text-xs" data-testid="roi-calc-steps">
                <tbody>
                  {result.steps
                    .filter((s) => s.key !== 'recordedValue' && s.key !== 'successFee' && s.key !== 'mentorTimeCost')
                    .map((s) => (
                      <tr key={s.key} className="border-b border-gray-100 dark:border-gray-800 last:border-0 align-top">
                        <td className="py-1 pr-3 text-gray-700 dark:text-gray-300">{t.roi.steps[s.key]}</td>
                        <td className="py-1 font-mono text-gray-500 dark:text-gray-400 break-all">{s.expression}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
