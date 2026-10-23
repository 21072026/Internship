'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import { AffiliateTabs } from '../AffiliateTabs';

// Payouts (docs/affiliate-module.md, #3116): after the bank transfer, record it —
// the selected APPROVED commissions of one partner become PAID together, or
// nothing does (the writer decides, under the partner's lock).

interface Partner {
  id: string;
  code: string;
  displayName: string;
  payoutIban: string | null;
  totals: { APPROVED: number };
}
interface Commission {
  id: string;
  amountMinor: number;
  dueAt: string;
  customerRef: string;
  payment: { externalPaymentRef: string };
}
interface Payout {
  id: string;
  partner: { displayName: string };
  amountMinor: number;
  currency: string;
  paidAt: string;
  reference: string | null;
  commissions: number;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function AffiliatePayoutsPage() {
  const t = useT();
  const L = t.affiliatePayouts;
  const locale = useLocale();
  const toast = useToast();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [payouts, setPayouts] = useState<{ rows: Payout[]; canWrite: boolean } | null>(null);
  const [partnerId, setPartnerId] = useState('');
  const [approved, setApproved] = useState<Commission[] | null>(null);
  const [approvedAll, setApprovedAll] = useState<{ totalCount: number; totalAmountMinor: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paidOn, setPaidOn] = useState(today());
  const [reference, setReference] = useState('');
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, q] = await Promise.all([fetch('/api/admin/affiliate/payouts'), fetch('/api/admin/affiliate/partners')]);
    if (p.status === 403 || q.status === 403) {
      setForbidden(true);
      return;
    }
    if (!p.ok || !q.ok) {
      setFailed(true);
      return;
    }
    setPayouts(await p.json());
    setPartners((await q.json()).partners);
  }, []);

  const loadApproved = useCallback(async (id: string) => {
    setApproved(null);
    if (!id) return;
    // Not paged: everything a payout can take (up to the writer's limit), with the
    // totals of all approved rows — the sum shown is always the rows listed.
    const res = await fetch(`/api/admin/affiliate/payouts/candidates?partnerId=${encodeURIComponent(id)}`);
    const body = res.ok ? await res.json() : { rows: [], totalCount: 0, totalAmountMinor: 0 };
    const rows: Commission[] = body.rows;
    setApproved(rows);
    setApprovedAll({ totalCount: body.totalCount, totalAmountMinor: body.totalAmountMinor });
    setSelected(new Set(rows.map((r) => r.id)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadApproved(partnerId);
  }, [partnerId, loadApproved]);

  const money = (minor: number, currency = 'EUR') => formatMinorAmount(minor, currency, locale);
  const partner = partners.find((p) => p.id === partnerId) ?? null;
  const sum = useMemo(() => (approved ?? []).filter((c) => selected.has(c.id)).reduce((s, c) => s + c.amountMinor, 0), [approved, selected]);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/affiliate/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partnerId, commissionIds: [...selected], paidOn, reference: reference || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(interpolate(L.saved, { amount: money(body.amountMinor, body.currency), n: String(body.count) }));
        setReference('');
        await Promise.all([load(), loadApproved(partnerId)]);
      } else toast(body.code === 'payout_mismatch' ? L.mismatch : L.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;
  if (failed) return <p className="text-sm text-red-600" role="alert">{L.failed}</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliateAdmin.title}</h1>
      <AffiliateTabs />
      {payouts && !payouts.canWrite && <p className="text-sm text-gray-600 dark:text-gray-400">{L.readOnly}</p>}

      {payouts?.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>{L.record}</CardTitle>
            <p className="text-sm text-gray-600 dark:text-gray-400">{L.recordHint}</p>
          </CardHeader>
          <div className="space-y-4">
            <Select
              label={L.partner}
              value={partnerId}
              onChange={(e) => setPartnerId(e.target.value)}
              options={[
                { value: '', label: L.choosePartner },
                ...partners.map((p) => ({ value: p.id, label: `${p.displayName} (${p.code}) · ${money(p.totals.APPROVED)}` })),
              ]}
              data-testid="affiliate-payout-partner"
            />
            {partner && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {partner.payoutIban ? interpolate(L.payoutAccount, { iban: partner.payoutIban }) : L.payoutAccountNone} {L.payoutAccountHint}
              </p>
            )}
            {partnerId && approved === null && <SkeletonRows rows={2} />}
            {approved && approved.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">{L.noApproved}</p>}
            {approved && approved.length > 0 && (
              <>
                {approvedAll && approvedAll.totalCount > approved.length && (
                  <p className="text-sm text-amber-700 dark:text-amber-300" role="status" data-testid="affiliate-payout-truncated">
                    {interpolate(L.truncated, { shown: String(approved.length), total: String(approvedAll.totalCount), amount: money(approvedAll.totalAmountMinor) })}
                  </p>
                )}
                <ul className="space-y-1 text-sm" data-testid="affiliate-payout-commissions">
                  {approved.map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={c.payment.externalPaymentRef}
                        checked={selected.has(c.id)}
                        onChange={() => {
                          const next = new Set(selected);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          setSelected(next);
                        }}
                      />
                      <span className="font-mono">{c.customerRef}</span>
                      <span className="font-mono text-gray-500">{c.payment.externalPaymentRef}</span>
                      <span>{formatDate(c.dueAt, locale, { timeZone: 'UTC' })}</span>
                      <span className="ml-auto">{money(c.amountMinor)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm font-medium" data-testid="affiliate-payout-sum">{interpolate(L.selected, { n: String(selected.size), amount: money(sum) })}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input type="date" label={L.paidOn} max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                  <Input label={L.reference} hint={L.referenceHint} value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
                <Button type="button" disabled={busy || selected.size === 0 || !paidOn} onClick={() => void save()} data-testid="affiliate-payout-save">
                  {L.save}
                </Button>
              </>
            )}
          </div>
        </Card>
      )}

      <Card padding="none">
        <div className="px-4 pt-4">
          <CardTitle>{L.history}</CardTitle>
        </div>
        {!payouts ? (
          <div className="p-4"><SkeletonRows rows={3} /></div>
        ) : payouts.rows.length === 0 ? (
          <div className="p-4"><EmptyState testId="affiliate-payouts" title={L.empty} size="sm" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-2">{L.colDate}</th>
                  <th className="px-4 py-2">{L.colPartner}</th>
                  <th className="px-4 py-2 text-right">{L.colAmount}</th>
                  <th className="px-4 py-2 text-right">{L.colCount}</th>
                  <th className="px-4 py-2">{L.colRef}</th>
                </tr>
              </thead>
              <tbody>
                {payouts.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.paidAt, locale, { timeZone: 'UTC' })}</td>
                    <td className="px-4 py-2">{r.partner.displayName}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{money(r.amountMinor, r.currency)}</td>
                    <td className="px-4 py-2 text-right">{r.commissions}</td>
                    <td className="px-4 py-2 font-mono">{r.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
