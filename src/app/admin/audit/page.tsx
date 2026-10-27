'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';
import { AUDIT_EXPORT_MAX_ROWS } from '@/lib/auditRetentionRule';

interface Person {
  id: string;
  name: string | null;
  email: string;
}

interface Entry {
  id: string;
  action: string;
  actorId: string;
  actor: Person | null;
  targetId: string | null;
  target: Person | null;
  detail: string | null;
  createdAt: string;
  // The ActivityLog twin of an impersonation row (#1583): where it came from.
  activity: { id: string; ip: string | null; userAgent: string | null } | null;
}

function who(p: Person | null, id: string | null): string {
  if (p) return p.name ? `${p.name} <${p.email}>` : p.email;
  return id ?? '—';
}

// The audit trail viewer (#1583) — the sibling of /admin/activity. The rows
// are the privileged actions (impersonation, password resets, merges, offer
// and interview decisions); GET /api/admin/audit gates on `audit.read`.
export default function AdminAuditPage() {
  const t = useT();
  const [items, setItems] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [targetId, setTargetId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // One filter string for the list and the export (#1585), so the file is
  // exactly the rows the screen is filtered to — every page of them.
  const filters = useMemo(() => {
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (actor) params.set('actor', actor);
    if (targetId) params.set('targetId', targetId);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params.toString();
  }, [action, actor, targetId, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams(filters);
    params.set('page', String(page));
    const res = await fetch(`/api/admin/audit?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(res.status === 403 ? t.audit.forbidden : t.audit.loadError);
      setItems([]);
      setTotal(0);
    } else {
      setError(null);
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    }
    setLoading(false);
  }, [filters, page, t]);

  useEffect(() => {
    load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / 50));
  const input = 'px-3 py-2 border border-gray-300 rounded-lg text-sm';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.audit.title}</h1>
        <p className="text-gray-500 mt-1">{t.audit.subtitle}</p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input data-testid="audit-filter-action" aria-label={t.audit.actionFilter} placeholder={t.audit.actionFilter} value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} className={input} />
        <input data-testid="audit-filter-actor" aria-label={t.audit.actorFilter} placeholder={t.audit.actorFilter} value={actor} onChange={(e) => { setPage(1); setActor(e.target.value); }} className={input} />
        <input data-testid="audit-filter-target" aria-label={t.audit.targetFilter} placeholder={t.audit.targetFilter} value={targetId} onChange={(e) => { setPage(1); setTargetId(e.target.value.trim()); }} className={input} />
        <label className="flex items-center gap-1 text-sm text-gray-500">
          {t.audit.from}
          <input data-testid="audit-filter-from" type="date" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value); }} className={input} />
        </label>
        <label className="flex items-center gap-1 text-sm text-gray-500">
          {t.audit.to}
          <input data-testid="audit-filter-to" type="date" value={to} onChange={(e) => { setPage(1); setTo(e.target.value); }} className={input} />
        </label>
        <a
          data-testid="audit-export"
          href={`/api/admin/audit/export${filters ? `?${filters}` : ''}`}
          download
          title={t.audit.exportHint.replace('{n}', String(AUDIT_EXPORT_MAX_ROWS))}
          className="ml-auto inline-flex items-center px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
        >
          {t.audit.exportCsv}
        </a>
      </div>

      <Card>
        <CardHeader><CardTitle>{t.audit.title} ({total})</CardTitle></CardHeader>
        {loading ? (
          <SkeletonRows rows={8} />
        ) : error ? (
          <p role="alert" className="text-center py-12 text-gray-500">{error}</p>
        ) : items.length === 0 ? (
          <p className="text-center py-12 text-gray-400">{t.audit.none}</p>
        ) : (
          <div className="divide-y divide-gray-50" data-testid="audit-rows">
            {items.map((e) => (
              <div key={e.id} data-testid="audit-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <Badge variant={e.action.startsWith('IMPERSONATE') ? 'warning' : 'default'} className="flex-shrink-0">{e.action}</Badge>
                <span className="min-w-0 truncate text-gray-900">
                  {who(e.actor, e.actorId)}
                  {e.targetId ? <span className="text-gray-500"> → {who(e.target, e.targetId)}</span> : null}
                </span>
                <RelativeTime date={e.createdAt} className="ml-auto text-xs text-gray-400 flex-shrink-0" />
                {e.detail ? <span className="w-full min-w-0 truncate text-gray-500">{e.detail}</span> : null}
                {e.activity ? (
                  <span className="w-full text-xs text-gray-500" data-testid="audit-activity">
                    {t.audit.origin}: <span className="font-mono">{e.activity.ip || '—'}</span>
                    {e.activity.userAgent ? <span className="ml-2">{e.activity.userAgent}</span> : null}
                    {' · '}
                    <Link
                      className="text-blue-600 hover:underline"
                      href={`/admin/activity?action=${encodeURIComponent(e.action === 'IMPERSONATE_STOP' ? 'impersonate.stop' : 'impersonate.start')}`}
                    >
                      {t.audit.openActivity}
                    </Link>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</Button>
            <span className="text-sm text-gray-500">{page} / {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>→</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
