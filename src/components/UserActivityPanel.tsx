'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useT, useLocale } from '@/i18n/client';

interface Item {
  id: string;
  level: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

// Per-user activity feed. `flagInactive` (mentor view) shows a warning when the
// user hasn't been active for a while.
export function UserActivityPanel({ userId, flagInactive = false }: { userId: string; flagInactive?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<Item[]>([]);
  const [lastActiveAt, setLastActiveAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/users/${userId}/activity`);
    if (res.ok) {
      const d = await res.json();
      setItems(d.items ?? []);
      setLastActiveAt(d.lastActiveAt ?? null);
    }
    setLoading(false);
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const daysSince = lastActiveAt ? Math.floor((Date.now() - new Date(lastActiveAt).getTime()) / 86_400_000) : null;
  const inactive = flagInactive && (daysSince === null || daysSince >= 14);

  return (
    <Card>
      <CardHeader><CardTitle>{t.activityFeed.title}</CardTitle></CardHeader>

      {inactive && (
        <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          {daysSince === null ? t.activityFeed.neverActive : t.activityFeed.inactiveDays.replace('{d}', String(daysSince))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">{t.common.loading}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-400">{t.activityFeed.none}</p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {items.map((i) => (
            <div key={i.id} className="flex items-center gap-2 text-sm border-b border-gray-50 pb-1.5 last:border-0">
              <Badge variant={i.level === 'WARNING' ? 'warning' : i.level === 'ERROR' ? 'danger' : 'info'} className="text-[10px]">{i.level}</Badge>
              <span className="font-mono text-xs text-gray-700">{i.action}</span>
              {i.detail && <span className="text-xs text-gray-400 truncate">· {i.detail}</span>}
              <span className="ml-auto text-[11px] text-gray-400 flex-shrink-0">{new Date(i.createdAt).toLocaleDateString(locale)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
