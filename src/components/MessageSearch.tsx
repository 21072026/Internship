'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';

interface Hit {
  id: string;
  snippet: string;
  createdAt: string;
  senderName: string | null;
  mine: boolean;
  thread: { kind: 'conversation' | 'relation'; id: string; name: string };
  href: string;
}

// The inbox's message search (#1609). The server decides which threads it may
// look in (GET /api/messages/search, the caller's own threads only, each one
// through the gate that opening it would use); this only asks and lists. A hit
// links into its thread at that message.
export function MessageSearch() {
  const t = useT();
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (query.length < 2) { setError(t.messages.search.tooShort); setHits(null); setAsked(null); return; }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/messages/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) { setError(t.messages.search.failed); setHits(null); return; }
      const d = await res.json();
      setHits(d.results ?? []);
      setAsked(query);
    } catch {
      setError(t.messages.search.failed);
    } finally {
      setBusy(false);
    }
  };

  const clear = () => { setQ(''); setHits(null); setAsked(null); setError(''); };

  return (
    <div className="mb-4" data-testid="message-search">
      <form onSubmit={run} role="search" className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t.messages.search.label}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.messages.search.placeholder}
            maxLength={100}
            data-testid="message-search-input"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
        <Button type="submit" size="sm" loading={busy} data-testid="message-search-submit">{t.messages.search.submit}</Button>
        {(hits || error) && (
          <button
            type="button"
            onClick={clear}
            aria-label={t.messages.search.clear}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            data-testid="message-search-clear"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </form>
      {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
      {hits && asked && (
        <div className="mt-3 rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900" data-testid="message-search-results">
          <p className="px-2 py-1 text-xs font-medium text-gray-500">
            {(hits.length ? t.messages.search.results : t.messages.search.noResults).replace('{q}', asked)}
          </p>
          {hits.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {hits.map((h) => (
                <li key={h.id}>
                  <Link href={h.href} className="block rounded-lg px-2 py-2 hover:bg-gray-50 dark:hover:bg-gray-800" data-testid="message-search-result" data-message-id={h.id}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{h.thread.name}</span>
                      <RelativeTime date={h.createdAt} className="shrink-0 text-xs text-gray-400" />
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500">
                      {h.mine ? `${t.messages.you}: ` : h.senderName ? `${h.senderName}: ` : ''}
                      {h.snippet}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
