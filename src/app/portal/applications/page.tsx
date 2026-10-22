'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Send } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { nextStages } from '@/lib/applications';

// The mentee's own applications (#1832): role, company, where it stands and
// when they applied, with a withdraw that cannot be undone. Rows come from
// GET /api/applications, which scopes a MENTEE to their own server-side.

type Row = {
  id: string;
  stage: string;
  createdAt: string;
  requisition: { id: string; title: string; company: { id: string; name: string } };
};

const VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  APPLIED: 'info', SCREENING: 'info', SHORTLISTED: 'warning', INTERVIEW: 'warning', OFFER: 'warning', HIRED: 'success', REJECTED: 'default', WITHDRAWN: 'default',
};

export default function PortalApplicationsPage() {
  const t = useT();
  const A = t.portalApplications;
  const locale = useLocale();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pending, setPending] = useState<Row | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/applications').catch(() => null);
    setRows(res?.ok ? (await res.json()).applications ?? [] : []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const withdraw = async (row: Row) => {
    setError('');
    const res = await fetch(`/api/applications/${row.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'withdraw' }) });
    if (!res.ok) setError(A.failed);
    setPending(null);
    await load();
  };

  return (
    <div data-testid="portal-applications">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{A.title}</h1>
        <p className="mt-1 text-gray-600 dark:text-gray-400">{A.subtitle}</p>
      </div>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {rows === null ? (
        <p className="py-10 text-center text-gray-600 dark:text-gray-400" data-testid="page-loading">{t.common.loading}</p>
      ) : rows.length === 0 ? (
        <EmptyState testId="portal-applications-empty" icon={Send} title={A.empty} body={A.emptyHint} action={{ label: A.browse, href: '/portal/jobs' }} />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id} data-testid={`application-row-${row.id}`}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/portal/jobs/${row.requisition.id}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">{row.requisition.title}</Link>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{row.requisition.company.name}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">{A.applied.replace('{date}', formatDate(row.createdAt, locale))}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={VARIANT[row.stage] ?? 'default'} data-testid={`application-stage-${row.id}`}>{A.stages[row.stage as keyof typeof A.stages] ?? row.stage}</Badge>
                  {nextStages(row.stage).includes('WITHDRAWN') && (
                    <Button size="sm" variant="outline" onClick={() => setPending(row)} data-testid={`application-withdraw-${row.id}`}>{A.withdraw}</Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={A.withdrawTitle}
        message={A.withdrawBody}
        confirmLabel={A.withdraw}
        cancelLabel={A.cancel}
        variant="danger"
        onConfirm={() => pending && void withdraw(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
