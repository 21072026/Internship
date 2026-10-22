'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount, parseMinorUnits } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import { AffiliateTabs } from '../AffiliateTabs';

// Customer payments (docs/affiliate-module.md, #3116): record one by hand, see
// the commission the plan gave it. The writer decides everything; the amount is
// typed the way a person writes it ("19,99") and sent as minor units.

interface Row {
  id: string;
  receivedAt: string;
  amountMinor: number;
  currency: string;
  externalPaymentRef: string;
  customerRef: string;
  partner: { id: string; code: string; displayName: string };
  commission: { kind: 'TIER' | 'PERCENT'; amountMinor: number; status: string } | null;
}
interface Partner {
  id: string;
  code: string;
  displayName: string;
  status: string;
}

// The admin's own calendar day (the server allows up to +14 h ahead of UTC).
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function AffiliatePaymentsPage() {
  const t = useT();
  const L = t.affiliatePayments;
  const locale = useLocale();
  const toast = useToast();
  const [data, setData] = useState<{ rows: Row[]; total: number; page: number; perPage: number; canWrite: boolean } | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ partnerId: '', customerExternalRef: '', amount: '', receivedOn: today(), externalPaymentRef: '' });

  const load = useCallback(async () => {
    const [p, q] = await Promise.all([fetch(`/api/admin/affiliate/payments?page=${page}`), fetch('/api/admin/affiliate/partners')]);
    if (!p.ok || !q.ok) {
      setFailed(true);
      return;
    }
    setData(await p.json());
    setPartners((await q.json()).partners);
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: number, currency = 'EUR') => formatMinorAmount(minor, currency, locale);

  async function save() {
    const amountMinor = parseMinorUnits(form.amount);
    if (amountMinor === null || Number.isNaN(amountMinor)) {
      toast(L.errors.invalid_input, 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/affiliate/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partnerId: form.partnerId || null,
          customerExternalRef: form.customerExternalRef,
          amountMinor,
          receivedOn: form.receivedOn,
          externalPaymentRef: form.externalPaymentRef,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const moved = (body.created ?? 0) + (body.updated ?? 0);
        toast(moved > 0 ? interpolate(L.savedCommission, { n: String(moved) }) : L.saved);
        if (body.drift > 0) toast(interpolate(L.drift, { n: String(body.drift) }), 'error');
        setForm({ ...form, customerExternalRef: '', amount: '', externalPaymentRef: '' });
        setPage(1);
        await load();
      } else {
        const code = body.code as keyof typeof L.errors | undefined;
        toast(code && code in L.errors ? L.errors[code] : L.failed, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <p className="text-sm text-red-600" role="alert">{L.failed}</p>;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

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
            <Input label={L.amount} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="affiliate-payment-amount" />
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

      {!data ? (
        <SkeletonRows rows={5} />
      ) : data.rows.length === 0 ? (
        <EmptyState testId="affiliate-payments" title={L.empty} />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-payment-table">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-2">{L.colDate}</th>
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2">{L.colPartner}</th>
                  <th className="px-4 py-2 text-right">{L.colAmount}</th>
                  <th className="px-4 py-2">{L.colRef}</th>
                  <th className="px-4 py-2">{L.colCommission}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.receivedAt, locale, { timeZone: 'UTC' })}</td>
                    <td className="px-4 py-2 font-mono">{r.customerRef}</td>
                    <td className="px-4 py-2">{r.partner.displayName}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{money(r.amountMinor, r.currency)}</td>
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
              <Button type="button" size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{L.prev}</Button>
              <span>{interpolate(L.page, { page: String(page), pages: String(pages) })}</span>
              <Button type="button" size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>{L.next}</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
