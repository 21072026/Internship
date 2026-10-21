'use client';

import { useCallback, useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';

// The operator queue of plan-change requests (#1743). Super admins only — the
// API answers 403 to everybody else, and this screen says so instead of
// rendering an empty queue. Reached from /admin/organizations (the other
// operator controls live there), so a tenant admin's sidebar does not carry a
// link that only ever refuses.

interface Row {
  id: string;
  requestedPlan: string;
  billingCycle: string;
  currentPlan: string;
  activePairs: number | null;
  reason: string | null;
  educationClaim: boolean;
  status: 'NEW' | 'APPLIED' | 'REJECTED';
  note: string | null;
  createdAt: string;
  handledAt: string | null;
  org: { name: string; slug: string };
  requestedBy: { fullName: string; email: string } | null;
}

type Filter = 'NEW' | 'ALL';

export default function PlanRequestsPage() {
  const t = useT();
  const p = t.planRequests;
  const [filter, setFilter] = useState<Filter>('NEW');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [discount, setDiscount] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/admin/plan-requests?status=${filter}`)
      .then(async (r) => {
        if (r.status === 403) {
          setForbidden(true);
          return;
        }
        const d = r.ok ? await r.json() : { requests: [] };
        setRows(d.requests ?? []);
      })
      .catch(() => setRows([]));
  }, [filter]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (row: Row, action: 'apply' | 'reject') => {
    setBusy(row.id);
    setFlash(null);
    try {
      const res = await fetch(`/api/admin/plan-requests/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          note: notes[row.id] ?? null,
          ...(action === 'apply' && row.educationClaim ? { educationDiscount: discount[row.id] ?? false } : {}),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) setFlash(action === 'apply' ? p.applied : p.rejected);
      else setFlash(d.code === 'note_required' ? p.noteRequired : d.code === 'not_open' ? p.notOpen : (d.error ?? t.common.error));
      load();
    } finally {
      setBusy(null);
    }
  };

  if (forbidden) {
    return (
      <Card>
        <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="plan-requests-forbidden">
          {p.operatorsOnly}
        </p>
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{p.title}</h1>
        <p className="text-gray-500 dark:text-gray-400 mt-1">{p.subtitle}</p>
      </div>

      {flash && (
        <div className="mb-4 rounded-lg border border-gray-200 p-3 text-sm text-gray-800 dark:border-gray-700 dark:text-gray-100" role="status">
          {flash}
        </div>
      )}

      <div className="mb-4 flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1 max-w-xs" role="tablist" aria-label={p.title}>
        {(['NEW', 'ALL'] as Filter[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={filter === k}
            onClick={() => setFilter(k)}
            data-testid={`plan-requests-filter-${k}`}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              filter === k ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            {p.filters[k]}
          </button>
        ))}
      </div>

      {rows === null ? (
        <SkeletonRows rows={4} />
      ) : rows.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="plan-requests-empty">
            {p.empty}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <Card key={r.id} data-testid={`plan-request-${r.id}`}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Receipt className="h-5 w-5 text-blue-600" aria-hidden />
                  <CardTitle>{r.org.name}</CardTitle>
                  <Badge variant={r.status === 'NEW' ? 'warning' : r.status === 'APPLIED' ? 'success' : 'default'}>{p.status[r.status]}</Badge>
                  {r.educationClaim && <Badge variant="info">{p.educationClaim}</Badge>}
                </div>
              </CardHeader>
              <dl className="grid gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">{p.from}</dt>
                  <dd className="text-gray-900 dark:text-gray-100">{r.currentPlan}</dd>
                </div>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">{p.to}</dt>
                  <dd className="text-gray-900 dark:text-gray-100" data-testid="plan-request-to">
                    {r.requestedPlan} · {p.cycles[r.billingCycle as keyof typeof p.cycles] ?? r.billingCycle}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">{p.activePairs}</dt>
                  <dd className="text-gray-900 dark:text-gray-100">{r.activePairs ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-gray-500 dark:text-gray-400">{p.requested}</dt>
                  <dd className="text-gray-900 dark:text-gray-100">
                    <RelativeTime date={r.createdAt} />
                    {r.requestedBy && <span className="block text-xs text-gray-500 dark:text-gray-400">{r.requestedBy.fullName} · {r.requestedBy.email}</span>}
                  </dd>
                </div>
              </dl>
              {r.reason && <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-200">{r.reason}</p>}
              {r.status !== 'NEW' && r.note && (
                <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
                  {p.note}: {r.note}
                </p>
              )}
              {r.status === 'NEW' && (
                <div className="mt-4 space-y-3">
                  <label className="block text-sm">
                    <span className="text-gray-700 dark:text-gray-200">{p.note}</span>
                    <textarea
                      className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                      rows={2}
                      maxLength={2000}
                      value={notes[r.id] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                      data-testid="plan-request-note"
                    />
                  </label>
                  {r.educationClaim && (
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                      <input
                        type="checkbox"
                        checked={discount[r.id] ?? false}
                        onChange={(e) => setDiscount((d) => ({ ...d, [r.id]: e.target.checked }))}
                        data-testid="plan-request-discount"
                      />
                      {p.grantDiscount}
                    </label>
                  )}
                  <div className="flex gap-2">
                    <Button onClick={() => act(r, 'apply')} disabled={busy === r.id} data-testid="plan-request-apply">
                      {p.apply}
                    </Button>
                    <Button variant="secondary" onClick={() => act(r, 'reject')} disabled={busy === r.id} data-testid="plan-request-reject">
                      {p.reject}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
