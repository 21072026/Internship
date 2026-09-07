'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { NotificationTypeIcon } from '@/components/NotificationTypeIcon';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { renderNotification } from '@/lib/notificationText';

interface NotificationItem {
  id: string;
  type: string;
  text?: string | null;
  params?: unknown;
  link: string | null;
  read: boolean;
  createdAt: string;
}

const PAGE_SIZE = 20;

// Wait this long after the last keystroke before asking the server (#1646).
// Short enough to feel live, long enough that typing a word is one request
// instead of one per letter — and every one of those requests is a `contains`
// scan on a TEXT column.
const SEARCH_DEBOUNCE_MS = 300;

// Shared focus/hover/touch-target treatment for every clickable notification
// row (card or link) — WCAG 2.2 minimum target size is 44x44px.
const ROW_INTERACTIVE_CLASSES =
  'min-h-11 flex items-start gap-3 cursor-pointer transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2';

export default function NotificationsPage() {
  const t = useT();
  const locale = useLocale();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [types, setTypes] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [readFilter, setReadFilter] = useState<'all' | 'unread' | 'read'>('all');
  const [typeFilter, setTypeFilter] = useState('');
  // Two pieces of state on purpose: `search` is what the box shows (so typing
  // never lags), `query` is what has actually been sent. Only the second one is
  // a dependency of `load`.
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), read: readFilter });
      if (typeFilter) params.set('type', typeFilter);
      if (query) params.set('q', query);
      const res = await fetch(`/api/notifications?${params}`);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setTypes(data.types ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [page, readFilter, typeFilter, query]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce the box into `query`; the trailing edge is what gets searched.
  //
  // The page reset happens in the same tick as the query change, not in a second
  // effect watching `query`: two state updates in one handler are batched into a
  // single render and therefore a single fetch, where a follow-up effect would
  // fire one request for "page 2 of the new search" before correcting itself.
  // Keyed off the keystroke means it only ever runs while somebody is typing —
  // paging through an existing result set never resets itself.
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);
  const filtersActive = readFilter !== 'all' || typeFilter !== '' || search !== '';
  // Tell "you have no notifications" apart from "this search matched none".
  const searching = query !== '';

  const markRead = async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  };

  const markAllRead = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  };

  const clearFilters = () => {
    setReadFilter('all');
    setTypeFilter('');
    setSearch('');
    setQuery('');
    setPage(1);
  };

  const typeOptions = [
    { value: '', label: t.notifications.allTypes },
    ...types.map((type) => ({
      value: type,
      // i18n event keys are dotted ("message.new"); their category label is
      // keyed by the first segment, same as the legacy flat types.
      label:
        (t.notifications.types as Record<string, string>)[type] ??
        (t.notifications.types as Record<string, string>)[type.split('.')[0]] ??
        type,
    })),
  ];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.notifications.pageTitle}</h1>
          <p className="text-gray-500 mt-1">{t.notifications.pageSubtitle}</p>
        </div>
        {!loading && !error && (
          <Badge variant="info">
            {total} {t.notifications.itemLabel}
          </Badge>
        )}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-4">
        <div className="flex-1 min-w-0">
          {/* data-testid, not `input[type="search"]`: AdminNav renders its own
              sidebar search box on every admin page and an unscoped selector
              picks that one up instead. */}
          <Input
            label={t.notifications.searchLabel}
            type="search"
            data-testid="notifications-search"
            placeholder={t.notifications.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-0">
          <Select
            label={t.notifications.filterStatus}
            className="min-h-11"
            value={readFilter}
            onChange={(e) => {
              setReadFilter(e.target.value as 'all' | 'unread' | 'read');
              setPage(1);
            }}
            options={[
              { value: 'all', label: t.notifications.allStatuses },
              { value: 'unread', label: t.notifications.unreadOnly },
              { value: 'read', label: t.notifications.readOnly },
            ]}
          />
        </div>
        <div className="flex-1 min-w-0">
          <Select
            label={t.notifications.filterType}
            className="min-h-11"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
            options={typeOptions}
          />
        </div>
        {filtersActive && (
          <Button variant="ghost" size="sm" className="min-h-11" onClick={clearFilters}>
            {t.notifications.clearFilters}
          </Button>
        )}
        <Button variant="outline" size="sm" className="min-h-11" onClick={markAllRead}>
          {t.notifications.markAllRead}
        </Button>
      </div>

      {loading ? (
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      ) : error ? (
        <Card>
          <p className="text-sm text-red-500 text-center py-10">{t.notifications.loadError}</p>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <p className="text-sm text-gray-400 text-center py-10" data-testid="notifications-empty">
            {searching ? t.notifications.searchNone : t.notifications.none}
          </p>
        </Card>
      ) : (
        <div className="space-y-3" data-testid="notifications-list">
          {items.map((n) => {
            const cardContent = (
              <Card
                padding="sm"
                tabIndex={n.link ? undefined : 0}
                role={n.link ? undefined : 'button'}
                onClick={n.link ? undefined : () => !n.read && markRead(n.id)}
                onKeyDown={
                  n.link
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (!n.read) markRead(n.id);
                        }
                      }
                }
                /* A read row is told apart by its border and its muted text,
                   NOT by opacity: `opacity-60` dimmed the row's text INTO its
                   background (3.4:1 in dark, 2.3:1 in light) and no colour token
                   can win that argument, because it fades the text and the card
                   under it by the same amount (#2131). */
                className={`${ROW_INTERACTIVE_CLASSES} ${
                  n.read
                    ? 'border-gray-100 dark:border-gray-800'
                    : 'border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-900/10'
                }`}
              >
                <div
                  className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
                    n.read ? 'bg-gray-100 dark:bg-gray-800 text-gray-400' : 'bg-blue-100 dark:bg-blue-900/40 text-blue-600'
                  }`}
                >
                  <NotificationTypeIcon type={n.type} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`break-words text-sm ${n.read ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100 font-medium'}`}>
                    {renderNotification(n, t, locale)}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">{formatDateTime(n.createdAt, locale)}</p>
                </div>
                {!n.read && <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 flex-shrink-0" aria-hidden="true" />}
              </Card>
            );
            return n.link ? (
              <Link
                key={n.id}
                href={n.link}
                onClick={() => markRead(n.id)}
                className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
              >
                {cardContent}
              </Link>
            ) : (
              <div key={n.id}>{cardContent}</div>
            );
          })}
        </div>
      )}

      {!loading && !error && total > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-6">
          <span className="text-sm text-gray-500">
            {rangeStart}–{rangeEnd} / {total} {t.notifications.itemLabel}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 min-w-11"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t.common.prev}
              </Button>
              <span className="text-sm text-gray-500">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 min-w-11"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                {t.common.next}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
