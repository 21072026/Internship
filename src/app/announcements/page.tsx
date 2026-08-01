'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

interface AnnouncementItem {
  id: string;
  text: string;
  link: string | null;
  imageUrl: string | null;
  createdAt: string;
}

const PAGE_SIZE = 10;

export default function AnnouncementsPage() {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<AnnouncementItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/announcements?page=${page}&pageSize=${PAGE_SIZE}`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      setItems(data.announcements ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.announcementFeed.pageTitle}</h1>
        <p className="text-gray-500 mt-1">{t.announcementFeed.pageSubtitle}</p>
      </div>

      <Card padding="none">
        {loading ? (
          <div className="p-6">
            <SkeletonRows rows={5} />
          </div>
        ) : error ? (
          <p className="text-sm text-red-500 text-center py-10">{t.announcementFeed.loadError}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-10">{t.announcementFeed.none}</p>
        ) : (
          <div data-testid="announcements-full-list">
            {items.map((a) => (
              <div key={a.id} className="px-4 py-4 border-b border-gray-50 dark:border-gray-800 last:border-0">
                <p className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">{a.text}</p>
                {a.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.imageUrl}
                    alt=""
                    data-testid="announcement-image"
                    className="mt-2 max-h-96 w-auto max-w-full rounded-lg border border-gray-200 dark:border-gray-700 object-contain"
                  />
                )}
                {a.link && (
                  <a href={a.link} target={a.link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline block mt-1">
                    {a.link}
                  </a>
                )}
                <p className="text-xs text-gray-400 mt-2">{formatDateTime(a.createdAt, locale)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {!loading && !error && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {t.common.prev}
          </Button>
          <span className="text-sm text-gray-500">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            {t.common.next}
          </Button>
        </div>
      )}
    </div>
  );
}
