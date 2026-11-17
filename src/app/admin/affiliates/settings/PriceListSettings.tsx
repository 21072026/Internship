'use client';

import { useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { listPriceMinor, MAX_PRICE_STEPS, parsePriceList, type PriceList } from '@/lib/affiliatePriceListRule';

// The transaction price list (#3843, src/lib/affiliatePriceListRule.ts): what a
// month's transaction count costs, the base of a first payment's one-off
// commission. The server is the judge (parsePriceList); this form turns what a
// person types — "9,90", "0,033", "19" % — into milli-minor units and basis
// points, shows live what a few counts would cost, and marks the fields the
// server names.

interface StepForm {
  upTo: string;
  unit: string;
}
interface Form {
  freeUpTo: string;
  baseCovers: string;
  baseFee: string;
  steps: StepForm[];
  vat: string;
  reverseChargeAddsVat: boolean;
}

const EMPTY: Form = { freeUpTo: '', baseCovers: '', baseFee: '', steps: [{ upTo: '', unit: '' }], vat: '', reverseChargeAddsVat: true };

/** Milli-minor units → "0,033" / "9,90" (at least two decimals, trailing zeros beyond dropped). */
function priceText(milli: number, locale: string): string {
  let s = (milli / 100_000).toFixed(5).replace(/0{1,3}$/, '');
  if (locale !== 'en') s = s.replace('.', ',');
  return s;
}
/** "0,033" → 3300 milli-minor; NaN when it is not a price with at most five decimals. */
function parsePriceMilli(text: string): number {
  const t = text.trim().replace(',', '.');
  const m = /^(\d{1,9})(?:\.(\d{1,5}))?$/.exec(t);
  if (!m) return NaN;
  return Number(m[1]) * 100_000 + Number((m[2] ?? '').padEnd(5, '0'));
}
function parseCount(text: string): number {
  return /^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : NaN;
}
function parseVatBps(text: string): number {
  const t = text.trim().replace(',', '.');
  return /^\d{1,3}(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : NaN;
}

function formFrom(p: PriceList | null, locale: string): Form {
  if (!p) return EMPTY;
  return {
    freeUpTo: String(p.freeUpTo),
    baseCovers: String(p.baseCovers),
    baseFee: priceText(p.baseFeeMilli, locale),
    steps: p.steps.map((s) => ({ upTo: s.upTo === null ? '' : String(s.upTo), unit: priceText(s.unitMilli, locale) })),
    vat: String(p.vatBps / 100).replace('.', locale === 'en' ? '.' : ','),
    reverseChargeAddsVat: p.reverseChargeAddsVat,
  };
}

function listFrom(f: Form) {
  return {
    freeUpTo: parseCount(f.freeUpTo),
    baseCovers: parseCount(f.baseCovers),
    baseFeeMilli: parsePriceMilli(f.baseFee),
    steps: f.steps.map((s, i) => ({ upTo: i === f.steps.length - 1 ? null : parseCount(s.upTo), unitMilli: parsePriceMilli(s.unit) })),
    vatBps: parseVatBps(f.vat),
    reverseChargeAddsVat: f.reverseChargeAddsVat,
  };
}

/** The counts the example table shows: each boundary and the transaction after it. */
function exampleCounts(p: PriceList): number[] {
  const counts = new Set<number>([p.freeUpTo, p.baseCovers, p.baseCovers + 1]);
  for (const s of p.steps) if (s.upTo !== null) [s.upTo, s.upTo + 1].forEach((n) => counts.add(n));
  return [...counts].filter((n) => n >= 1).sort((a, b) => a - b).slice(0, 8);
}

export function PriceListSettings({ initial, currency, readOnly }: { initial: PriceList | null; currency: string; readOnly: boolean }) {
  const t = useT();
  const L = t.affiliateSettings;
  const locale = useLocale();
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => formFrom(initial, locale));
  const [configured, setConfigured] = useState(initial !== null);
  const [issues, setIssues] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const err = (field: string) => (issues.has(field) ? L.errorInvalid : undefined);
  const money = (minor: number) => formatMinorAmount(minor, currency, locale);

  const draft = useMemo(() => parsePriceList(listFrom(form)), [form]);
  const examples = draft.ok ? exampleCounts(draft.priceList) : [];

  async function put(priceList: unknown) {
    setBusy(true);
    setIssues(new Set());
    try {
      const res = await fetch('/api/admin/affiliate/settings/price-list', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceList }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(body.changed ? L.priceListSaved : L.priceListUnchanged);
        setConfigured(body.priceList !== null);
        setForm(formFrom(body.priceList, locale));
      } else if (body.code === 'invalid_price_list') {
        setIssues(new Set((body.issues ?? []).map((i: { field: string }) => i.field)));
        toast(L.errorInvalid, 'error');
      } else toast(body.code === 'conflict' ? L.errorConflict : L.loadFailed, 'error');
    } finally {
      setBusy(false);
    }
  }

  const setStep = (i: number, patch: Partial<StepForm>) => setForm({ ...form, steps: form.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{L.priceListTitle}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-400">{L.priceListHint}</p>
        {!configured && <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="affiliate-price-list-none">{L.priceListNone}</p>}
      </CardHeader>
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label={L.priceFreeUpTo} hint={L.priceFreeUpToHint} inputMode="numeric" value={form.freeUpTo} error={err('freeUpTo')} onChange={(e) => setForm({ ...form, freeUpTo: e.target.value })} data-testid="affiliate-price-free-up-to" />
          <Input label={L.priceBaseCovers} hint={L.priceBaseCoversHint} inputMode="numeric" value={form.baseCovers} error={err('baseCovers')} onChange={(e) => setForm({ ...form, baseCovers: e.target.value })} data-testid="affiliate-price-base-covers" />
          <Input label={interpolate(L.priceBaseFee, { currency })} hint={L.priceNetHint} inputMode="decimal" value={form.baseFee} error={err('baseFeeMilli')} onChange={(e) => setForm({ ...form, baseFee: e.target.value })} data-testid="affiliate-price-base-fee" />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{L.priceSteps}</p>
          <p className="text-xs text-gray-500">{L.priceStepsHint}</p>
          {form.steps.map((s, i) => {
            const last = i === form.steps.length - 1;
            return (
              <div key={i} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]" data-testid="affiliate-price-step">
                <Input
                  label={L.priceStepUpTo}
                  inputMode="numeric"
                  value={last ? '' : s.upTo}
                  placeholder={last ? L.priceStepOpen : undefined}
                  disabled={last}
                  error={err(`steps.${i}.upTo`)}
                  onChange={(e) => setStep(i, { upTo: e.target.value })}
                  data-testid={`affiliate-price-step-up-to-${i}`}
                />
                <Input
                  label={interpolate(L.priceStepUnit, { currency })}
                  inputMode="decimal"
                  value={s.unit}
                  error={err(`steps.${i}.unitMilli`)}
                  onChange={(e) => setStep(i, { unit: e.target.value })}
                  data-testid={`affiliate-price-step-unit-${i}`}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={form.steps.length === 1}
                  onClick={() => setForm({ ...form, steps: form.steps.filter((_, j) => j !== i) })}
                  aria-label={interpolate(L.priceStepRemove, { n: String(i + 1) })}
                >
                  ✕
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={form.steps.length >= MAX_PRICE_STEPS}
            // A new step goes before the open-ended last one.
            onClick={() => setForm({ ...form, steps: [...form.steps.slice(0, -1), { upTo: '', unit: '' }, form.steps[form.steps.length - 1]] })}
            data-testid="affiliate-price-step-add"
          >
            {L.priceStepAdd}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label={L.priceVat} inputMode="decimal" value={form.vat} error={err('vatBps')} onChange={(e) => setForm({ ...form, vat: e.target.value })} data-testid="affiliate-price-vat" />
          <label className="flex items-start gap-2 text-sm text-gray-700 sm:col-span-2 sm:self-end dark:text-gray-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.reverseChargeAddsVat}
              onChange={(e) => setForm({ ...form, reverseChargeAddsVat: e.target.checked })}
              data-testid="affiliate-price-reverse-charge-vat"
            />
            <span>
              {L.priceReverseChargeVat}
              <span className="block text-xs text-gray-500">{L.priceReverseChargeVatHint}</span>
            </span>
          </label>
        </div>

        {draft.ok && examples.length > 0 && (
          <div className="overflow-x-auto">
            <table className="text-sm" data-testid="affiliate-price-examples">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="py-1 pr-6">{L.priceExampleCount}</th>
                  <th className="py-1 pr-6 text-right">{L.priceExampleNet}</th>
                  <th className="py-1 text-right">{L.priceExampleGross}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {examples.map((n) => {
                  const net = listPriceMinor({ ...draft.priceList, vatBps: 0 }, n);
                  const gross = listPriceMinor(draft.priceList, n);
                  return (
                    <tr key={n} data-testid={`affiliate-price-example-${n}`}>
                      <td className="py-1 pr-6">{new Intl.NumberFormat(locale).format(n)}</td>
                      <td className="py-1 pr-6 text-right">{net.ok ? money(net.amountMinor) : '–'}</td>
                      <td className="py-1 text-right font-medium">{gross.ok ? money(gross.amountMinor) : '–'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-gray-500">{L.priceExampleHint}</p>
          </div>
        )}

        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void put(listFrom(form))} disabled={busy} data-testid="affiliate-save-price-list">
              {L.savePriceList}
            </Button>
            {configured && (
              <Button type="button" variant="ghost" onClick={() => void put(null)} disabled={busy} data-testid="affiliate-remove-price-list">
                {L.removePriceList}
              </Button>
            )}
          </div>
        )}
      </fieldset>
    </Card>
  );
}
