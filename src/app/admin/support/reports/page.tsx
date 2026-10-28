'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bug, MessageSquareText, Paperclip, Star } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import { SupportTabs } from '@/components/SupportTabs';
import {
  SUPPORT_REPORT_STATUSES,
  SUPPORT_REPORT_STATUS_VARIANT as STATUS_VARIANT,
  type SupportReportStatusKey,
} from '@/lib/supportReportStatus';
import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';

interface Row {
  id: string;
  type: 'BUG' | 'FEEDBACK';
  status: SupportReportStatusKey;
  rating: number | null;
  excerpt: string;
  url: string;
  createdAt: string;
  user: { id: string; fullName: string; email: string };
  _count: { files: number };
}

const field = 'rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

// The bug-report inbox (#3130): reports from the floating feedback button,
// filterable by type, status, date and reporter.
export default function AdminSupportReportsPage() {
  const t = useT();
  const a = t.adminReports;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');

  useEffect(() => {
    const p = new URLSearchParams();
    if (type) p.set('type', type);
    if (status) p.set('status', status);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (q.trim()) p.set('q', q.trim());
    if (sort === 'oldest') p.set('sort', 'oldest');
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/admin/support/reports?${p}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { reports: [] }))
        .then((d) => setRows(d.reports ?? []))
        .catch(() => { if (!ctrl.signal.aborted) setRows([]); });
    }, q ? 250 : 0);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [type, status, from, to, q, sort]);

  // WCAG 4.1.3 (#2864): the list is rewritten in place without moving focus,
  // so the new result count is spoken (debounced) while a filter is active.
  useFilterAnnouncement(rows && (type !== '' || status !== '' || from !== '' || to !== '' || q.trim() !== '') ? resultCountMessage(t.a11y, rows.length) : null);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <Bug className="h-6 w-6 text-blue-600" aria-hidden="true" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{a.title}</h1>
      </div>
      <p className="mb-6 text-gray-500">{a.subtitle}</p>
      <SupportTabs />

      <div className="mb-4 flex flex-wrap items-end gap-3" data-testid="report-filters">
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">{a.filterType}
          <select className={field} value={type} onChange={(e) => setType(e.target.value)} data-testid="report-filter-type">
            <option value="">{a.all}</option>
            <option value="BUG">{a.typeBUG}</option>
            <option value="FEEDBACK">{a.typeFEEDBACK}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">{a.filterStatus}
          <select className={field} value={status} onChange={(e) => setStatus(e.target.value)} data-testid="report-filter-status">
            <option value="">{a.all}</option>
            {SUPPORT_REPORT_STATUSES.map((s) => <option key={s} value={s}>{a[`status${s}`]}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">{a.filterFrom}
          <input type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">{a.filterTo}
          <input type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">{a.filterReporter}
          <input type="search" className={field} value={q} placeholder={a.filterReporterPlaceholder} onChange={(e) => setQ(e.target.value)} data-testid="report-filter-reporter" />
        </label>
        <label className="flex flex-col text-xs text-gray-600 dark:text-gray-400">{a.sortLabel}
          <select className={field} value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')}>
            <option value="newest">{a.sortNewest}</option>
            <option value="oldest">{a.sortOldest}</option>
          </select>
        </label>
      </div>

      {rows === null ? (
        <p className="py-10 text-center text-gray-400" data-testid="page-loading">{t.common.loading}</p>
      ) : rows.length === 0 ? (
        <Card><p className="py-10 text-center text-gray-500">{a.empty}</p></Card>
      ) : (
        <ul className="space-y-2" data-testid="report-list">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/support/reports/${r.id}`} className="block rounded-xl border border-gray-200 bg-white p-4 hover:border-blue-300 dark:border-gray-800 dark:bg-gray-900" data-testid={`report-row-${r.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
                      {r.type === 'BUG' ? <Bug className="h-4 w-4 text-red-600" aria-hidden="true" /> : <MessageSquareText className="h-4 w-4 text-blue-600" aria-hidden="true" />}
                      <span className="truncate">{r.user.fullName}</span>
                      <span className="text-xs font-normal text-gray-500">{r.user.email}</span>
                    </p>
                    <p className="mt-0.5 truncate text-sm text-gray-600 dark:text-gray-400">{r.excerpt}</p>
                    <p className="mt-0.5 truncate font-mono text-xs text-gray-500">{r.url}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
                    {r.rating ? <span className="flex items-center gap-0.5"><Star className="h-3.5 w-3.5 fill-current text-amber-600" aria-hidden="true" />{r.rating}</span> : null}
                    {r._count.files > 0 && <span className="flex items-center gap-0.5"><Paperclip className="h-3.5 w-3.5" aria-hidden="true" />{r._count.files}</span>}
                    <Badge variant={r.type === 'BUG' ? 'danger' : 'info'}>{a[`type${r.type}`]}</Badge>
                    <Badge variant={STATUS_VARIANT[r.status]}>{a[`status${r.status}`]}</Badge>
                    <RelativeTime date={r.createdAt} />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
