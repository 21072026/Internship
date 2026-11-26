'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';
import { ORG_MAIL_LOG_STATUSES, type OrgMailLogStatus } from '@/lib/orgMailLogRule';

// The org admin's mail log (#3955): every mail to one of the organization's
// people — went out, held for approval, skipped and why, failed. Read from
// GET /api/admin/mail-log (`mail.read`), only this organization's rows. Any
// vertical — a sales org had no way to see whether a mail left at all.

interface Row {
  id: string;
  createdAt: string;
  status: OrgMailLogStatus;
  category: string | null;
  to: string;
  reason: string | null;
}

const VARIANT: Record<OrgMailLogStatus, 'success' | 'danger' | 'default' | 'warning' | 'info'> = {
  SENT: 'success',
  FAILED: 'danger',
  SKIPPED: 'default',
  DEFERRED: 'warning',
  HELD: 'info',
};

export default function OrgMailLogPage() {
  const t = useT();
  const m = t.mailLog;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [limited, setLimited] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [to, setTo] = useState('');
  const [days, setDays] = useState<7 | 30>(7);

  useEffect(() => {
    const p = new URLSearchParams({ days: String(days) });
    if (status) p.set('status', status);
    if (category) p.set('category', category);
    if (to.trim()) p.set('to', to.trim());
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/admin/mail-log?${p}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          setRows(d.rows ?? []);
          setCategories(d.categories ?? []);
          setLimited(!!d.limited);
          setFailed(false);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setFailed(true);
        });
    }, to ? 300 : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [status, category, to, days]);

  useFilterAnnouncement(rows && (status || category || to.trim()) ? resultCountMessage(t.a11y, rows.length) : null);

  const field = 'rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
  return (
    <div className="space-y-4" data-testid="org-mail-log">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{m.title}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{m.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">
          {m.filterStatus}
          <select className={field} value={status} onChange={(e) => setStatus(e.target.value)} data-testid="mail-log-filter-status">
            <option value="">{m.all}</option>
            {ORG_MAIL_LOG_STATUSES.map((s) => (
              <option key={s} value={s}>{m.status[s]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">
          {m.filterCategory}
          <select className={field} value={category} onChange={(e) => setCategory(e.target.value)} data-testid="mail-log-filter-category">
            <option value="">{m.all}</option>
            {categories.map((c) => (
              <option key={c.category} value={c.category}>{`${c.category} (${c.count})`}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">
          {m.filterTo}
          <input type="email" className={field} value={to} placeholder={m.filterToPlaceholder} onChange={(e) => setTo(e.target.value)} data-testid="mail-log-filter-to" />
        </label>
        <div role="group" aria-label={m.filterDays} className="inline-flex rounded-md border border-gray-200 p-0.5 text-sm dark:border-gray-700">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={`min-h-9 rounded px-3 font-medium ${days === d ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'text-gray-600 dark:text-gray-300'}`}
              data-testid={`mail-log-days-${d}`}
            >
              {m.lastDays.replace('{n}', String(d))}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t.common.error}</p>
      ) : rows === null ? (
        <p className="py-10 text-center text-gray-400">{t.common.loading}</p>
      ) : rows.length === 0 ? (
        <Card><p className="py-10 text-center text-gray-500" data-testid="mail-log-empty">{m.empty}</p></Card>
      ) : (
        <Card padding="sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="mail-log-table">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="py-2 pr-3">{m.colWhen}</th>
                  <th className="py-2 pr-3">{m.colStatus}</th>
                  <th className="py-2 pr-3">{m.colCategory}</th>
                  <th className="py-2 pr-3">{m.colTo}</th>
                  <th className="py-2">{m.colReason}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 align-top dark:border-gray-800" data-testid="mail-log-row" data-status={r.status}>
                    <td className="whitespace-nowrap py-2 pr-3 text-gray-600 dark:text-gray-400"><RelativeTime date={r.createdAt} /></td>
                    <td className="py-2 pr-3"><Badge variant={VARIANT[r.status] ?? 'default'}>{m.status[r.status] ?? r.status}</Badge></td>
                    <td className="py-2 pr-3 font-mono text-xs text-gray-700 dark:text-gray-300">{r.category ?? '—'}</td>
                    <td className="break-all py-2 pr-3 text-gray-800 dark:text-gray-200" data-private>{r.to}</td>
                    <td className="py-2 text-xs text-gray-600 dark:text-gray-400">{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {limited && <p className="mt-2 text-xs text-gray-500">{m.limited}</p>}
        </Card>
      )}
    </div>
  );
}
