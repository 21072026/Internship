'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { HIRING_QUEUES, type HiringQueue } from '@/lib/hiringQueues';

// The programme owner's hiring desk (#1874): four queues of things waiting on a
// human, each with its real total, at most 20 rows and a link to the screen
// where the action is taken. Every queue resolves to rows or an explicit empty
// state; a failed request shows an error with a retry, never a spinner that
// does not end (#1374).

type Row = {
  id: string;
  candidate?: string;
  requisition?: string;
  company?: string | null;
  position?: string;
  stage?: string;
  daysWaiting?: number;
  expiresAt?: string;
  openings?: number;
  filled?: number;
  href: string;
};
type Payload = {
  stallDays: number;
  header: { openRoles: number; hiresThisMonth: number; offersOutstanding: number; acceptanceRate: number | null };
  queues: Record<HiringQueue, { total: number; items: Row[] }>;
};

const SEE_ALL: Record<HiringQueue, string> = {
  awaitingDecision: '/admin/interview-requests',
  stalledApplications: '/admin/candidates',
  offersExpiring: '/admin/offers?status=SENT&expiringWithinDays=7',
  emptyRoles: '/admin/requisitions',
};

export default function AdminHiringPage() {
  const t = useT();
  const text = t.hiringDesk;
  const locale = useLocale();
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch('/api/admin/hiring/queues');
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const waiting = (n: number) => (n === 0 ? text.today : n === 1 ? text.daysWaitingOne : text.daysWaiting.replace('{n}', String(n)));

  const describe = (queue: HiringQueue, row: Row): { title: string; detail: string } => {
    switch (queue) {
      case 'awaitingDecision':
        return { title: `${row.candidate} · ${row.requisition}`, detail: [row.company, waiting(row.daysWaiting ?? 0)].filter(Boolean).join(' · ') };
      case 'stalledApplications':
        return {
          title: `${row.candidate} · ${row.requisition}`,
          detail: [(text.stages as Record<string, string>)[row.stage ?? ''] ?? row.stage, waiting(row.daysWaiting ?? 0)].filter(Boolean).join(' · '),
        };
      case 'offersExpiring':
        return {
          title: `${row.candidate} · ${row.position}`,
          detail: [row.company, row.expiresAt ? text.expires.replace('{when}', formatDate(row.expiresAt, locale)) : null].filter(Boolean).join(' · '),
        };
      case 'emptyRoles':
        return {
          title: `${row.requisition}`,
          detail: [row.company, text.seats.replace('{filled}', String(row.filled ?? 0)).replace('{openings}', String(row.openings ?? 0)), waiting(row.daysWaiting ?? 0)].filter(Boolean).join(' · '),
        };
    }
  };

  return (
    <div data-testid="admin-hiring">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{text.title}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{text.subtitle}</p>
      </div>

      {failed ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30" role="alert" data-testid="hiring-load-error">
          <p className="text-sm text-red-700 dark:text-red-300">{text.loadFailed}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>{text.retry}</Button>
        </div>
      ) : !data ? (
        <p className="py-10 text-center text-gray-600 dark:text-gray-400" data-testid="page-loading">{t.common.loading}</p>
      ) : (
        <>
          <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="hiring-header">
            {([
              ['openRoles', data.header.openRoles],
              ['hiresThisMonth', data.header.hiresThisMonth],
              ['offersOutstanding', data.header.offersOutstanding],
              ['acceptanceRate', data.header.acceptanceRate === null ? text.header.noData : `${data.header.acceptanceRate} %`],
            ] as const).map(([key, value]) => (
              <div key={key} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                <dt className="text-xs font-medium text-gray-600 dark:text-gray-400">{text.header[key]}</dt>
                <dd className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid={`hiring-header-${key}`}>{value}</dd>
              </div>
            ))}
          </dl>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {HIRING_QUEUES.map((queue) => {
              const q = data.queues[queue];
              const labels = text.queues[queue];
              return (
                <Card key={queue} data-testid={`hiring-queue-${queue}`}>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="flex items-center gap-2">
                        {labels.title}
                        <Badge variant={q.total > 0 ? 'warning' : 'default'} data-testid={`hiring-queue-${queue}-count`}>{q.total}</Badge>
                      </CardTitle>
                      <Link href={SEE_ALL[queue]} className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">{text.seeAll}</Link>
                    </div>
                    {queue === 'stalledApplications' && (
                      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{text.queues.stalledApplications.hint.replace('{days}', String(data.stallDays))}</p>
                    )}
                  </CardHeader>
                  {q.items.length === 0 ? (
                    <p className="text-sm text-gray-600 dark:text-gray-400" data-testid={`hiring-queue-${queue}-empty`}>{labels.empty}</p>
                  ) : (
                    <>
                      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                        {q.items.map((row) => {
                          const { title, detail } = describe(queue, row);
                          return (
                            <li key={row.id} data-testid={`hiring-queue-${queue}-row-${row.id}`}>
                              <Link href={row.href} className="block rounded px-1 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{title}</span>
                                <span className="block text-xs text-gray-600 dark:text-gray-400">{detail}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                      {q.total > q.items.length && (
                        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{text.countOf.replace('{shown}', String(q.items.length)).replace('{total}', String(q.total))}</p>
                      )}
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
