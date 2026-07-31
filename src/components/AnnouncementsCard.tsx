'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Megaphone } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardFooter } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';

interface AnnouncementItem {
  id: string;
  text: string;
  link: string | null;
  createdAt: string;
}

const LIMIT = 5;

// Shared "recent announcements" card for the mentee and mentor dashboards
// (#920). Reads straight from the Announcement table — independent of the
// per-user Notification bell/history — since every admin broadcast targets
// all active users, so any signed-in user sees the same feed.
export function AnnouncementsCard() {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<AnnouncementItem[] | null>(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/announcements?page=1&pageSize=${LIMIT}`);
        const data = res.ok ? await res.json() : { announcements: [] };
        if (!cancelled) setItems(data.announcements ?? []);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-blue-600" />
          <CardTitle>{t.announcementFeed.cardTitle}</CardTitle>
        </div>
      </CardHeader>

      {items === null ? (
        <SkeletonRows rows={3} />
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">{t.announcementFeed.none}</p>
      ) : (
        <div className="space-y-3" data-testid="announcements-list">
          {items.map((a) => {
            const inner = (
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">{a.text}</p>
                <p className="text-xs text-gray-400 mt-1">{formatDate(a.createdAt, locale)}</p>
              </div>
            );
            return (
              <div key={a.id} className="pb-3 border-b border-gray-50 dark:border-gray-800 last:border-0 last:pb-0">
                {a.link ? (
                  <a href={a.link} target={a.link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className="block hover:opacity-80">
                    {inner}
                  </a>
                ) : (
                  inner
                )}
              </div>
            );
          })}
        </div>
      )}

      <CardFooter>
        <Link href="/announcements" className="text-sm text-blue-600 hover:underline">
          {t.announcementFeed.viewAll} →
        </Link>
      </CardFooter>
    </Card>
  );
}
