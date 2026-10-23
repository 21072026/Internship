'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import { AffiliateTabs } from '../AffiliateTabs';

// Commissions (docs/affiliate-module.md, #3116): by status, oldest due first;
// approve / reject / back to pending in bulk; and the drift list — frozen rows
// the current plan would calculate differently, shown, never changed.

const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'REJECTED'] as const;
type Status = (typeof STATUSES)[number];
type Transition = 'APPROVE' | 'REJECT' | 'UNAPPROVE';

interface Row {
  id: string;
  kind: 'TIER' | 'PERCENT';
  amountMinor: number;
  currency: string;
  status: Status;
  dueAt: string;
  planVersion: number;
  partner: { code: string; displayName: string };
  customerRef: string;
  payment: { amountMinor: number; externalPaymentRef: string };
}
interface Data {
  rows: Row[];
  total: number;
  page: number;
  perPage: number;
  totals: Record<Status, { count: number; amountMinor: number }>;
  canWrite: boolean;
}
interface Drift {
  commissionId: string | null;
  paymentId: string;
  partnerId: string;
  status: Status | null;
  planVersion: number | null;
  expected: { kind: 'TIER' | 'PERCENT'; amountMinor: number } | null;
}

export default function AffiliateCommissionsPage() {
  const t = useT();
  const L = t.affiliateCommissions;
  const locale = useLocale();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('PENDING');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Data | null>(null);
  const [drift, setDrift] = useState<Drift[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, d] = await Promise.all([fetch(`/api/admin/affiliate/commissions?status=${status}&page=${page}`), fetch('/api/admin/affiliate/commissions/drift')]);
    if (c.status === 403 || d.status === 403) {
      setForbidden(true);
      return;
    }
    if (!c.ok || !d.ok) {
      setFailed(true);
      return;
    }
    setData(await c.json());
    setDrift((await d.json()).drift);
    setSelected(new Set());
  }, [status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: number) => formatMinorAmount(minor, 'EUR', locale);

  async function act(transition: Transition) {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/affiliate/commissions/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], transition }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast(interpolate(L.moved, { n: String(body.moved) }));
        if (body.skipped?.length > 0) toast(interpolate(L.skipped, { n: String(body.skipped.length) }), 'error');
        if (body.failedPartners > 0) toast(interpolate(L.failedPartners, { n: String(body.failedPartners) }), 'error');
        await load();
      } else toast(L.failed, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;
  if (failed) return <p className="text-sm text-red-600" role="alert">{L.failed}</p>;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const actions: Transition[] = status === 'PENDING' ? ['APPROVE', 'REJECT'] : status === 'APPROVED' ? ['UNAPPROVE'] : [];
  const actionLabel: Record<Transition, string> = { APPROVE: L.approve, REJECT: L.reject, UNAPPROVE: L.unapprove };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliateAdmin.title}</h1>
      <AffiliateTabs />
      {data && !data.canWrite && <p className="text-sm text-gray-600 dark:text-gray-400">{L.readOnly}</p>}

      <div className="flex flex-wrap gap-2" role="group">
        {STATUSES.map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={s === status ? 'primary' : 'outline'}
            aria-pressed={s === status}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            data-testid={`affiliate-commissions-${s}`}
          >
            {L[`status${s}`]}
            {data && <span className="ml-2 opacity-80">{interpolate(L.total, { count: String(data.totals[s].count), amount: money(data.totals[s].amountMinor) })}</span>}
          </Button>
        ))}
      </div>

      {!data ? (
        <SkeletonRows rows={5} />
      ) : data.rows.length === 0 ? (
        <EmptyState testId="affiliate-commissions" title={L.empty} />
      ) : (
        <Card padding="none">
          {data.canWrite && actions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2 dark:border-gray-800">
              {actions.map((a) => (
                <Button key={a} type="button" size="sm" variant={a === 'REJECT' ? 'danger' : 'primary'} disabled={busy || selected.size === 0} onClick={() => void act(a)} data-testid={`affiliate-commission-${a}`}>
                  {actionLabel[a]}
                </Button>
              ))}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr>
                  {data.canWrite && actions.length > 0 && (
                    <th className="px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label={L.selectAll}
                        checked={selected.size === data.rows.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(data.rows.map((r) => r.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th className="px-4 py-2">{L.colDue}</th>
                  <th className="px-4 py-2">{L.colPartner}</th>
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2 text-right">{L.colPayment}</th>
                  <th className="px-4 py-2 text-right">{L.colCommission}</th>
                  <th className="px-4 py-2">{L.colPlan}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    {data.canWrite && actions.length > 0 && (
                      <td className="px-4 py-2">
                        <input type="checkbox" aria-label={`${L.select}: ${r.payment.externalPaymentRef}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                      </td>
                    )}
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.dueAt, locale, { timeZone: 'UTC' })}</td>
                    <td className="px-4 py-2">{r.partner.displayName}</td>
                    <td className="px-4 py-2 font-mono">{r.customerRef}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{money(r.payment.amountMinor)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {money(r.amountMinor)} <Badge>{L[`kind${r.kind}`]}</Badge>
                    </td>
                    <td className="px-4 py-2">{interpolate(L.planV, { n: String(r.planVersion) })}</td>
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

      <Card>
        <CardHeader>
          <CardTitle>{L.driftTitle}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.driftHint}</p>
        </CardHeader>
        {!drift ? (
          <SkeletonRows rows={2} />
        ) : drift.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-drift-none">{L.driftNone}</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="affiliate-drift-list">
            {drift.map((d) => (
              <li key={`${d.paymentId}-${d.commissionId ?? 'none'}`}>
                {d.status ? <Badge>{L[`status${d.status}`]}</Badge> : <Badge>{L.driftNothing}</Badge>}{' '}
                {d.planVersion !== null && interpolate(L.planV, { n: String(d.planVersion) })} →{' '}
                {interpolate(L.driftExpected, { value: d.expected ? `${money(d.expected.amountMinor)} (${L[`kind${d.expected.kind}`]})` : L.driftNothing })}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
