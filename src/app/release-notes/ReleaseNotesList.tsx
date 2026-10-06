'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Locale } from '@/i18n/config';
import { ReleaseNoteMedia } from '@/components/ReleaseNoteMedia';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { GITHUB_URL } from '@/components/landing/links';
import type { LocalizedReleaseNote, ReleaseNotesSlice } from '@/lib/releaseNotesPaging';

interface Props {
  initial: LocalizedReleaseNote[];
  total: number;
  pageSize: number;
  locale: Locale;
  labels: { loadMore: string; shown: string; loadError: string };
}

/**
 * The release cards plus the "Load more" control (paged, see
 * lib/releaseNotesPaging.ts). The control is a real link to `?show=N`, so the
 * page still pages without JavaScript; with it, the next slice is fetched and
 * appended in place.
 */
export function ReleaseNotesList({ initial, total, pageSize, locale, labels }: Props) {
  const [entries, setEntries] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);

  const fetchMore = useCallback(
    async (offset: number, until?: string): Promise<LocalizedReleaseNote[] | null> => {
      const qs = new URLSearchParams({ offset: String(offset), limit: String(pageSize), lang: locale });
      if (until) qs.set('until', until);
      const res = await fetch(`/release-notes/entries?${qs}`);
      if (!res.ok) return null;
      const data = (await res.json()) as ReleaseNotesSlice;
      return data.entries;
    },
    [pageSize, locale]
  );

  const loadMore = useCallback(
    async (until?: string): Promise<LocalizedReleaseNote[]> => {
      if (busy.current) return [];
      busy.current = true;
      setLoading(true);
      setError(false);
      try {
        const next = await fetchMore(entries.length, until);
        if (!next) {
          setError(true);
          return [];
        }
        setEntries((prev) => {
          const seen = new Set(prev.map((r) => r.version));
          return [...prev, ...next.filter((r) => !seen.has(r.version))];
        });
        return next;
      } catch {
        setError(true);
        return [];
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [entries.length, fetchMore]
  );

  // A feed permalink (`#v0.12.0`, #1383) may point past the first page: load
  // down to that card once, then scroll to it.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!hash.startsWith('v') || document.getElementById(hash)) return;
    const version = hash.slice(1);
    void loadMore(version).then((next) => {
      if (!next.some((r) => r.version === version)) return;
      requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
    });
  }, [loadMore]);

  const remaining = total - entries.length;

  return (
    <>
      <div className="space-y-6">
        {entries.map((r) => (
          <ReleaseCard key={r.version} note={r} locale={locale} />
        ))}
      </div>

      {remaining > 0 ? (
        <div className="mt-6 flex flex-col items-center gap-2">
          <a
            href={`?show=${entries.length + pageSize}`}
            data-testid="release-notes-load-more"
            aria-disabled={loading}
            onClick={(e) => {
              e.preventDefault();
              void loadMore();
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {labels.loadMore}
          </a>
          <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="release-notes-count">
            {labels.shown.replace('{shown}', String(entries.length)).replace('{total}', String(total))}
          </span>
          {error ? (
            <span role="alert" className="text-xs text-red-600">
              {labels.loadError}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * "3 gün önce", with the stamp it was derived from ("2026-08-25 09:25 UTC",
 * #1457) on hover. The releases before #1457 carry a day and no minute, so
 * those are anchored at noon UTC — at most twelve hours either way, which no
 * reading of "2 months ago" can tell apart — and their hover keeps the bare day.
 */
function ReleaseDate({ date, time, locale }: { date: string; time?: string; locale: Locale }) {
  return (
    <RelativeTime
      date={`${date}T${time ?? '12:00'}:00Z`}
      title={time ? `${date} ${time} UTC` : date}
      locale={locale}
      data-testid="release-date"
    />
  );
}

function ReleaseCard({ note: r, locale }: { note: LocalizedReleaseNote; locale: Locale }) {
  return (
    <div
      /* The permalink the feed items point at (#1383). */
      id={`v${r.version}`}
      /* The capture target for e2e/release-media.spec.ts (#2233). */
      data-testid="release-card"
      className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6 scroll-mt-20"
    >
      {/* Stacks on a phone: version + "3 gün önce · b174c20" side by side
          is wider than 360px in German (e2e/mobile-layout-audit). */}
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-3 mb-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">v{r.version}</h2>
        <span className="text-xs text-gray-400 sm:text-right">
          <ReleaseDate date={r.date} time={r.time} locale={locale} />
          {r.commit ? (
            <>
              {' · '}
              <a
                href={`${GITHUB_URL}/commit/${r.commit}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono hover:underline hover:text-blue-600"
              >
                {r.commit}
              </a>
            </>
          ) : null}
        </span>
      </div>
      <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300 list-disc list-inside">
        {r.highlights.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      {/* Optional (#2233), and permanently so: a backfill or an API fix
          has no screen to show. When a note does carry one, the picture
          is what tells a reader who has not seen the screen what
          changed. */}
      {r.media ? <ReleaseNoteMedia media={r.media} locale={locale} /> : null}
    </div>
  );
}
