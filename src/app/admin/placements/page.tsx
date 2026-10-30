'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { EMPLOYMENT_ATTRIBUTIONS } from '@/lib/placementKind';
import { INVOICE_STATES, effectiveAttribution, formatMinor, nextInvoiceStates, type InvoiceState, type ManualInvoiceState } from '@/lib/placementRule';
import type { PlacementRow } from '@/lib/placementQuery';

const STATE_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'info'> = {
  NOT_INVOICEABLE: 'default',
  INVOICEABLE: 'warning',
  INVOICED: 'success',
  WAIVED: 'info',
};

const FILTER_KEYS = ['from', 'to', 'companyId', 'invoiceState', 'attribution'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

// /admin/placements (#1765) — the placement ledger. Rows are stamped by the
// pipeline itself (src/lib/placementLedger.ts); this screen only filters,
// exports and moves the invoice state. The server decides whether a move is
// allowed (`canChangeInvoiceState()`); the buttons only offer the same list.
export default function PlacementsPage() {
  const t = useT();
  const locale = useLocale();
  const p = t.placements;

  const [filters, setFilters] = useState<Record<FilterKey, string>>({ from: '', to: '', companyId: '', invoiceState: '', attribution: '' });
  const [includeReversed, setIncludeReversed] = useState(false);
  const [rows, setRows] = useState<PlacementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);

  const query = (() => {
    const sp = new URLSearchParams();
    for (const key of FILTER_KEYS) if (filters[key]) sp.set(key, filters[key]);
    if (includeReversed) sp.set('includeReversed', '1');
    return sp.toString();
  })();

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/admin/placements?${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((d) => {
        if (cancelled) return;
        setRows(d.placements ?? []);
        setFailed(false);
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/companies?all=1')
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => { if (!cancelled) setCompanies(d?.companies ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function changeState(row: PlacementRow, to: ManualInvoiceState) {
    let invoiceRef: string | null = null;
    if (to === 'INVOICED') {
      invoiceRef = window.prompt(p.refPrompt)?.trim() || null;
      if (!invoiceRef) return;
    }
    setBusyId(row.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/placements/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceState: to, invoiceRef }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const code = body?.code as keyof typeof p.errors | undefined;
        setMessage((code && p.errors[code]) || p.errors.generic);
      }
      load();
    } finally {
      setBusyId(null);
    }
  }

  const set = (key: FilterKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilters((f) => ({ ...f, [key]: e.target.value }));

  const inputClass = 'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{p.title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-300">{p.subtitle}</p>
        </div>
        <a
          href={`/api/admin/export/placements?${query}`}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800"
          data-testid="placements-export"
        >
          <Download className="h-4 w-4" aria-hidden />
          {p.exportCsv}
        </a>
      </div>

      <div className="flex flex-wrap items-end gap-3" data-testid="placements-filters">
        <label className="flex flex-col gap-1 text-xs font-medium">
          {p.filters.from}
          <input type="date" value={filters.from} onChange={set('from')} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {p.filters.to}
          <input type="date" value={filters.to} onChange={set('to')} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {p.filters.company}
          <select value={filters.companyId} onChange={set('companyId')} className={inputClass}>
            <option value="">{p.filters.allCompanies}</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {p.filters.invoiceState}
          <select value={filters.invoiceState} onChange={set('invoiceState')} className={inputClass} data-testid="placements-filter-state">
            <option value="">{p.filters.allStates}</option>
            {INVOICE_STATES.map((s) => <option key={s} value={s}>{p.invoiceStates[s]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {p.filters.attribution}
          <select value={filters.attribution} onChange={set('attribution')} className={inputClass}>
            <option value="">{p.filters.allAttributions}</option>
            {EMPLOYMENT_ATTRIBUTIONS.map((a) => <option key={a} value={a}>{p.attributions[a]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={includeReversed} onChange={(e) => setIncludeReversed(e.target.checked)} data-testid="placements-include-reversed" />
          {p.filters.includeReversed}
        </label>
      </div>

      {message && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{message}</p>}

      {loading ? (
        <SkeletonRows />
      ) : failed ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{p.loadFailed}</p>
      ) : rows.length === 0 ? (
        <EmptyState testId="placements-empty" title={p.empty} icon={Receipt} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full text-sm" data-testid="placements-table">
            <thead className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
              <tr>
                <th scope="col" className="px-3 py-2">{p.columns.placedAt}</th>
                <th scope="col" className="px-3 py-2">{p.columns.mentee}</th>
                <th scope="col" className="px-3 py-2">{p.columns.company}</th>
                <th scope="col" className="px-3 py-2">{p.columns.requisition}</th>
                <th scope="col" className="px-3 py-2">{p.columns.mentor}</th>
                <th scope="col" className="px-3 py-2">{p.columns.source}</th>
                <th scope="col" className="px-3 py-2">{p.columns.attribution}</th>
                <th scope="col" className="px-3 py-2">{p.columns.fee}</th>
                <th scope="col" className="px-3 py-2">{p.columns.invoiceState}</th>
                <th scope="col" className="px-3 py-2">{p.columns.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((row) => (
                <tr key={row.id} data-testid={`placement-row-${row.relationId}`}>
                  <td className="whitespace-nowrap px-3 py-2">{formatDate(row.placedAt, locale)}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/candidates/${row.mentee.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      {row.mentee.fullName ?? '—'}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{row.company?.name ?? '—'}</td>
                  <td className="px-3 py-2">{row.requisition?.title ?? '—'}</td>
                  <td className="px-3 py-2">{row.mentor?.fullName ?? '—'}</td>
                  <td className="px-3 py-2">{row.source?.name ?? '—'}</td>
                  <td className="px-3 py-2">{p.attributions[effectiveAttribution(row.attribution)]}</td>
                  <td className="whitespace-nowrap px-3 py-2">{formatMinor(row.feeMinor, row.feeCurrency) || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={STATE_VARIANT[row.invoiceState] ?? 'default'} data-testid="placement-invoice-state">
                        {p.invoiceStates[row.invoiceState as InvoiceState] ?? row.invoiceState}
                      </Badge>
                      {row.reversedAt && <Badge variant="danger" data-testid="placement-reversed">{p.reversed}</Badge>}
                    </div>
                    {row.invoiceRef && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{row.invoiceRef}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {nextInvoiceStates(row.invoiceState, !!row.reversedAt).map((to) => (
                        <button
                          key={to}
                          type="button"
                          disabled={busyId === row.id}
                          onClick={() => changeState(row, to)}
                          className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
                          data-testid={`placement-action-${to}`}
                        >
                          {p.actions[to]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
