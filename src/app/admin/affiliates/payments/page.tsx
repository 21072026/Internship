'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CustomerName } from '@/components/affiliate/CustomerName';
import { CUSTOMER_LABEL_MAX } from '@/lib/affiliateCustomerLabelRule';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount, parseMinorUnits } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import { AffiliateTabs } from '../AffiliateTabs';
import { AffiliateListToolbar, SortHeader, useAffiliateListQuery } from '@/components/affiliate/AffiliateListControls';
import { PAYMENT_LIST, hasListFilter, listQueryParams } from '@/lib/affiliateListQueryRule';

// Customer payments (docs/affiliate-module.md, #3116): record one by hand, see
// the commission the plan gave it. The writer decides everything; the amount is
// typed the way a person writes it ("19,99") and sent as minor units.
// The amount is the COMMISSION BASE (#3553): either transactions × the
// undiscounted price per transaction, or the base amount itself — the writer's
// resolvePaymentBase() decides; this screen only shows the product it will get.
// A customer's partner-facing label (#3352) is edited from its row.
// Partner, search and date filters and the column sort (#3539) live in the URL
// and are applied on the server.

interface Row {
  id: string;
  receivedAt: string;
  amountMinor: number;
  transactionCount: number | null;
  unitPriceMinor: number | null;
  currency: string;
  externalPaymentRef: string;
  customerId: string;
  customerRef: string;
  customerLabel: string | null;
  customerReverseCharge: boolean;
  partner: { id: string; code: string; displayName: string };
  commission: { kind: 'TIER' | 'PERCENT' | 'IMPORTED'; amountMinor: number; status: string } | null;
}
interface Partner {
  id: string;
  code: string;
  displayName: string;
  status: string;
}

/** A whole number of transactions (≥ 1), or null. Digits only: "1.000" is not a count. */
function parseCount(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,10}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && Number.isSafeInteger(n) ? n : null;
}

// The admin's own calendar day (the server allows up to +14 h ahead of UTC).
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function AffiliatePaymentsPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={5} />}>
      <AffiliatePayments />
    </Suspense>
  );
}

function AffiliatePayments() {
  const t = useT();
  const L = t.affiliatePayments;
  const locale = useLocale();
  const toast = useToast();
  const [data, setData] = useState<{ rows: Row[]; total: number; page: number; perPage: number; canWrite: boolean } | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const A = t.affiliateList;
  const { query, set } = useAffiliateListQuery(PAYMENT_LIST);
  const page = query.page;
  const qs = listQueryParams(PAYMENT_LIST, query).toString();
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [labelFor, setLabelFor] = useState<{ customerId: string; draft: string; reverseCharge: boolean } | null>(null);
  const [form, setForm] = useState({ partnerId: '', customerExternalRef: '', amount: '', transactionCount: '', unitPrice: '', receivedOn: today(), externalPaymentRef: '' });
  const [mode, setMode] = useState<'breakdown' | 'amount'>('breakdown');

  const load = useCallback(async () => {
    const [p, q] = await Promise.all([fetch(`/api/admin/affiliate/payments?${qs}`), fetch('/api/admin/affiliate/partners')]);
    if (p.status === 403 || q.status === 403) {
      setForbidden(true);
      return;
    }
    if (!p.ok || !q.ok) {
      setFailed(true);
      return;
    }
    setData(await p.json());
    setPartners((await q.json()).partners);
  }, [qs]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: number, currency = 'EUR') => formatMinorAmount(minor, currency, locale);

  async function saveLabel() {
    if (!labelFor) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/affiliate/customers/${encodeURIComponent(labelFor.customerId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partnerLabel: labelFor.draft, reverseCharge: labelFor.reverseCharge }),
      });
      if (!res.ok) {
        toast(L.labelFailed, 'error');
        return;
      }
      toast(L.labelSaved);
      setLabelFor(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    let base: { amountMinor: number } | { transactionCount: number; unitPriceMinor: number };
    if (mode === 'amount') {
      const amountMinor = parseMinorUnits(form.amount);
      if (amountMinor === null || Number.isNaN(amountMinor)) {
        toast(L.errors.invalid_input, 'error');
        return;
      }
      base = { amountMinor };
    } else {
      const transactionCount = parseCount(form.transactionCount);
      const unitPriceMinor = parseMinorUnits(form.unitPrice);
      if (transactionCount === null) {
        toast(L.baseErrors.transaction_count, 'error');
        return;
      }
      if (unitPriceMinor === null || Number.isNaN(unitPriceMinor)) {
        toast(L.baseErrors.unit_price, 'error');
        return;
      }
      base = { transactionCount, unitPriceMinor };
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/affiliate/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId: form.partnerId || null,
          customerExternalRef: form.customerExternalRef,
          ...base,
          receivedOn: form.receivedOn,
          externalPaymentRef: form.externalPaymentRef,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const moved = (body.created ?? 0) + (body.updated ?? 0);
        toast(moved > 0 ? interpolate(L.savedCommission, { n: String(moved) }) : L.saved);
        if (body.drift > 0) toast(interpolate(L.drift, { n: String(body.drift) }), 'error');
        setForm({ ...form, customerExternalRef: '', amount: '', transactionCount: '', unitPrice: '', externalPaymentRef: '' });
        // The new payment is the newest: back to the first page of the default order.
        // (A changed URL reloads by itself; an unchanged one is reloaded here.)
        if (page > 1 || query.sort !== PAYMENT_LIST.defaultSort || query.dir !== PAYMENT_LIST.defaultDir) set({ page: 1, sort: PAYMENT_LIST.defaultSort, dir: PAYMENT_LIST.defaultDir });
        else await load();
      } else {
        const code = body.code as keyof typeof L.errors | undefined;
        // A commission-base refusal names its issue (#3553); say which one.
        const issue = Array.isArray(body.issues) ? (body.issues as string[]).find((i): i is keyof typeof L.baseErrors => i in L.baseErrors) : undefined;
        toast(issue ? L.baseErrors[issue] : code && code in L.errors ? L.errors[code] : L.failed, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;
  if (failed) return <p className="text-sm text-red-600" role="alert">{L.failed}</p>;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  // What the server will receive, before saving: "1.000" is a thousand euro.
  const parsedAmount = parseMinorUnits(form.amount);
  const amountPreview = parsedAmount === null || Number.isNaN(parsedAmount) ? undefined : interpolate(L.amountPreview, { amount: money(parsedAmount) });
  // The product the writer will record, live: "340 × 0,15 € = 51,00 €".
  const parsedCount = parseCount(form.transactionCount);
  const parsedPrice = parseMinorUnits(form.unitPrice);
  const breakdownPreview =
    parsedCount === null || parsedPrice === null || Number.isNaN(parsedPrice)
      ? undefined
      : interpolate(L.breakdownPreview, { count: new Intl.NumberFormat(locale).format(parsedCount), price: money(parsedPrice), amount: money(parsedCount * parsedPrice) });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliateAdmin.title}</h1>
      <AffiliateTabs />
      {data && !data.canWrite && <p className="text-sm text-gray-600 dark:text-gray-400">{L.readOnly}</p>}

      {data?.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>{L.add}</CardTitle>
            <p className="text-sm text-gray-600 dark:text-gray-400">{L.addHint}</p>
          </CardHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Select
              label={L.partner}
              value={form.partnerId}
              onChange={(e) => setForm({ ...form, partnerId: e.target.value })}
              options={[
                { value: '', label: L.partnerKnown },
                ...partners.filter((p) => p.status !== 'SUSPENDED').map((p) => ({ value: p.id, label: `${p.displayName} (${p.code})` })),
              ]}
              data-testid="affiliate-payment-partner"
            />
            <Input label={L.customerRef} hint={L.customerRefHint} value={form.customerExternalRef} onChange={(e) => setForm({ ...form, customerExternalRef: e.target.value })} data-testid="affiliate-payment-customer" />
            <div className="space-y-2 sm:col-span-2 lg:col-span-3">
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label={L.baseMode}>
                <span className="text-sm text-gray-600 dark:text-gray-400">{L.baseMode}</span>
                {(['breakdown', 'amount'] as const).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={mode === m ? 'primary' : 'secondary'}
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    data-testid={`affiliate-payment-mode-${m}`}
                  >
                    {m === 'breakdown' ? L.modeBreakdown : L.modeAmount}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {mode === 'breakdown' ? (
                  <>
                    <Input label={L.transactionCount} inputMode="numeric" value={form.transactionCount} onChange={(e) => setForm({ ...form, transactionCount: e.target.value })} data-testid="affiliate-payment-count" />
                    <Input label={L.unitPrice} inputMode="decimal" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} data-testid="affiliate-payment-unit-price" />
                    <p className="self-end pb-2 text-sm font-medium text-gray-900 tabular-nums dark:text-gray-100" aria-live="polite" data-testid="affiliate-payment-breakdown-preview">
                      {breakdownPreview}
                    </p>
                  </>
                ) : (
                  <Input label={L.amount} hint={amountPreview} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="affiliate-payment-amount" />
                )}
              </div>
              <p className="text-xs text-gray-500" data-testid="affiliate-payment-base-hint">{L.baseHint}</p>
            </div>
            <Input label={L.receivedOn} type="date" max={today()} value={form.receivedOn} onChange={(e) => setForm({ ...form, receivedOn: e.target.value })} data-testid="affiliate-payment-date" />
            <Input label={L.paymentRef} hint={L.paymentRefHint} value={form.externalPaymentRef} onChange={(e) => setForm({ ...form, externalPaymentRef: e.target.value })} data-testid="affiliate-payment-ref" />
          </div>
          <div className="mt-3">
            <Button type="button" disabled={busy} onClick={() => void save()} data-testid="affiliate-payment-save">
              {L.save}
            </Button>
          </div>
        </Card>
      )}

      <AffiliateListToolbar spec={PAYMENT_LIST} query={query} set={set} partners={partners} searchLabel={A.searchPayments} dateLabel={A.dateReceived} resultCount={data?.total ?? null} />

      {!data ? (
        <SkeletonRows rows={5} />
      ) : data.rows.length === 0 ? (
        <EmptyState testId="affiliate-payments" title={hasListFilter(query) ? A.noMatch : L.empty} />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-payment-table">
              <thead className="text-left text-gray-500">
                <tr>
                  <SortHeader label={L.colDate} sortKey="date" query={query} set={set} />
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2">{L.colPartner}</th>
                  <SortHeader label={L.colAmount} sortKey="amount" query={query} set={set} numeric />
                  <th className="px-4 py-2">{L.colRef}</th>
                  <th className="px-4 py-2">{L.colCommission}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800" data-testid="affiliate-payment-row">
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.receivedAt, locale, { timeZone: 'UTC' })}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-start gap-2">
                        <CustomerName label={r.customerLabel} reference={r.customerRef} />
                        {r.customerReverseCharge && (
                          <Badge data-testid="affiliate-customer-reverse-charge-badge">{L.reverseChargeBadge}</Badge>
                        )}
                        {data.canWrite && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setLabelFor({ customerId: r.customerId, draft: r.customerLabel ?? '', reverseCharge: r.customerReverseCharge })}
                            data-testid="affiliate-customer-label-edit"
                          >
                            {L.labelEdit}
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2">{r.partner.displayName}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {money(r.amountMinor, r.currency)}
                      {r.transactionCount !== null && r.unitPriceMinor !== null && (
                        <div className="text-xs text-gray-500" data-testid="affiliate-payment-breakdown">
                          {interpolate(L.breakdownLine, { count: new Intl.NumberFormat(locale).format(r.transactionCount), price: money(r.unitPriceMinor, r.currency) })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono">{r.externalPaymentRef}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.commission ? (
                        <>
                          {money(r.commission.amountMinor, r.currency)} <Badge>{L[`kind${r.commission.kind}`]}</Badge>
                        </>
                      ) : (
                        <span className="text-gray-500">{L.noCommission}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 text-sm">
              <Button type="button" size="sm" variant="ghost" disabled={page <= 1} onClick={() => set({ page: page - 1 })}>{L.prev}</Button>
              <span>{interpolate(L.page, { page: String(page), pages: String(pages) })}</span>
              <Button type="button" size="sm" variant="ghost" disabled={page >= pages} onClick={() => set({ page: page + 1 })}>{L.next}</Button>
            </div>
          )}
        </Card>
      )}
      <ConfirmDialog
        open={labelFor !== null}
        title={L.labelTitle}
        message={
          <div className="space-y-3">
            <Input
              label={L.labelField}
              hint={L.labelHint}
              maxLength={CUSTOMER_LABEL_MAX}
              value={labelFor?.draft ?? ''}
              onChange={(e) => setLabelFor((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
              data-testid="affiliate-customer-label-input"
            />
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={labelFor?.reverseCharge ?? false}
                onChange={(e) => setLabelFor((cur) => (cur ? { ...cur, reverseCharge: e.target.checked } : cur))}
                data-testid="affiliate-customer-reverse-charge"
              />
              <span>
                {L.reverseChargeField}
                <span className="block text-xs text-gray-500">{L.reverseChargeHint}</span>
              </span>
            </label>
          </div>
        }
        confirmLabel={L.labelSave}
        cancelLabel={L.labelCancel}
        loading={busy}
        onConfirm={() => void saveLabel()}
        onCancel={() => setLabelFor(null)}
      />
    </div>
  );
}
