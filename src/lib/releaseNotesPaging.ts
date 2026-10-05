// /release-notes is paged: the page renders the newest `RELEASE_NOTES_PAGE_SIZE`
// releases and a "Load more" control fetches the next slice from
// /release-notes/entries. With 500+ releases the page used to ship every one of
// them — HTML, three locales' worth of nothing the reader needs — on each visit.
//
// The slice is localized here, not on the client, so a chunk carries only the
// reader's language and the client bundle never imports the 7000-line
// RELEASE_NOTES array (only its types).

import type { Locale } from '@/i18n/config';
import { getAllReleaseNotes, type ReleaseMedia } from '@/lib/releaseNotes';

export const RELEASE_NOTES_PAGE_SIZE = 20;
/** Upper bound for a plain `limit` (an `until` deep link may go further). */
export const RELEASE_NOTES_MAX_LIMIT = 100;

/** One release as the page renders it: one locale's highlights. */
export interface LocalizedReleaseNote {
  version: string;
  date: string;
  time?: string;
  commit?: string;
  highlights: string[];
  media?: ReleaseMedia;
}

export interface ReleaseNotesSlice {
  entries: LocalizedReleaseNote[];
  total: number;
}

/**
 * `offset`/`limit` slice of all releases, newest first. With `until` the slice
 * is extended to include that version, so a feed permalink
 * (`/release-notes#v0.12.0`) loads down to its card in one request — bounded by
 * the build-time list itself. An unknown `until` is ignored.
 */
export function releaseNotesSlice(opts: {
  locale: Locale;
  offset?: number;
  limit?: number;
  until?: string | null;
  /** The page's own no-JS `?show=N` passes the list length here. */
  maxLimit?: number;
}): ReleaseNotesSlice {
  const all = getAllReleaseNotes();
  const offset = clampInt(opts.offset, 0, all.length, 0);
  let limit = clampInt(opts.limit, 1, opts.maxLimit ?? RELEASE_NOTES_MAX_LIMIT, RELEASE_NOTES_PAGE_SIZE);
  if (opts.until) {
    const idx = all.findIndex((r) => r.version === opts.until);
    if (idx >= offset) limit = Math.max(limit, idx - offset + 1);
  }
  return {
    total: all.length,
    entries: all.slice(offset, offset + limit).map((r) => ({
      version: r.version,
      date: r.date,
      time: r.time,
      commit: r.commit,
      highlights: r.highlights[opts.locale] ?? [],
      media: r.media,
    })),
  };
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
