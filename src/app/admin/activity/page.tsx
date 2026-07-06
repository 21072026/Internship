'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

interface Entry {
  id: string;
  level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  action: string;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: string | null;
  createdAt: string;
}

const LEVEL_VARIANT = { DEBUG: 'default', INFO: 'info', WARNING: 'warning', ERROR: 'danger' } as const;

export default function AdminActivityPage() {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState('');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (level) params.set('level', level);
    if (action) params.set('action', action);
    if (q) params.set('q', q);
    params.set('page', String(page));
    const res = await fetch(`/api/admin/activity?${params}`);
    const data = await res.json();
    setItems(data.items ?? []);
    setTotal(data.total ?? 0);
    setLoading(false);
  }, [level, action, q, page]);

  useEffect(() => {
    load();
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.activity.title}</h1>
        <p className="text-gray-500 mt-1">{t.activity.subtitle}</p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={level} onChange={(e) => { setPage(1); setLevel(e.target.value); }} className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="">{t.activity.allLevels}</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
        </select>
        <input placeholder={t.activity.actionFilter} value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
        <input placeholder={t.activity.userFilter} value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} className="px-3 py-2 border border-gray-300 rounded-lg text-sm" />
      </div>

      <Card>
        <CardHeader><CardTitle>{t.activity.title} ({total})</CardTitle></CardHeader>
        {loading ? (
          <SkeletonRows rows={8} />
        ) : items.length === 0 ? (
          <p className="text-center py-12 text-gray-400">{t.activity.none}</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {items.map((e) => (
              <div key={e.id} className="flex items-center gap-3 py-2.5 text-sm">
                <Badge variant={LEVEL_VARIANT[e.level]} className="flex-shrink-0">{e.level}</Badge>
                <span className="font-medium text-gray-900 flex-shrink-0">{e.action}</span>
                <span className="text-gray-500 truncate flex-1">
                  {e.actorEmail || '—'}{e.detail ? ` · ${e.detail}` : ''}
                </span>
                <span className="text-xs text-gray-400 flex-shrink-0">{formatDateTime(e.createdAt, locale)}</span>
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
