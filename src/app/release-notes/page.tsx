import type { Metadata } from 'next';
import { pageAlternates, pageMetadata } from '@/lib/pageMetadata';
import { headers } from 'next/headers';
import Link from 'next/link';
import { Rss, Sparkles } from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { getServerDictionary } from '@/i18n/server';
import { RELEASE_NOTES_PAGE_SIZE, releaseNotesSlice } from '@/lib/releaseNotesPaging';
import { publicOrigin, releaseFeedUrl } from '@/lib/releaseFeed';
import { APP_VERSION, GIT_SHA } from '@/lib/version';
import { PublicShell } from '@/components/landing/PublicShell';
import { ReleaseNotesList } from './ReleaseNotesList';
import { requireDefaultVertical } from '@/lib/verticalPage';
import { worldForHeaders } from '@/lib/hostWorld';
import { DEFAULT_VERTICAL } from '@/lib/verticals';

// Discoverability half of the feed (#1383): browsers and readers pick a feed up
// from this link, so subscribing is one click from the page. Locale-independent,
// hence the default-locale feed — the other two languages are the same URL with
// `?lang=`, and the visible link below follows the reader. Dynamic rather than
// static (#2488) only so the feed URL is built on the host the page was served
// from: on the marketing host it must not advertise the internship host's feed.
//
// The feed exists only on the internship host (feed.xml/route.ts, same host
// rule), and Next still emits this metadata on the page's 404 — so on any
// other host there is nothing to advertise.
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  if (worldForHeaders((n) => h.get(n)) !== DEFAULT_VERTICAL) return {};
  return {
    // Its own tab title in the reader's language (#1376).
    ...(await pageMetadata(
      (t) => ({ title: t.releaseNotes.title, description: t.releaseNotes.feedDescription }),
      '/release-notes/opengraph-image'
    )),
    // A page-level `alternates` replaces the layout's whole block, so the
    // canonical and the language siblings (#1386) are restated here.
    alternates: {
      ...(await pageAlternates()),
      types: {
        'application/rss+xml': [
          { url: releaseFeedUrl(publicOrigin((n) => h.get(n))), title: 'Internship CRM — release notes' },
        ],
      },
    },
  };
}

// Public, user-facing "what's new" page — friendly feature highlights per
// release, localized. Distinct from CHANGELOG.md (developer-facing, in the repo).
//
// Paged (lib/releaseNotesPaging.ts): the newest RELEASE_NOTES_PAGE_SIZE
// releases render here, the rest arrive through "Load more". `?show=N` is that
// button's no-JavaScript fallback.
export default async function ReleaseNotesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  // One feed for the whole codebase, and most of it is the internship
  // product's changelog — 205 visible lines of it on the marketing host
  // (#2544). Nothing tags a release with the vertical it concerns, so the feed
  // cannot be filtered honestly; until it can, it is the default product's.
  await requireDefaultVertical();
  const { locale, t } = await getServerDictionary();
  const h = await headers();
  const feedUrl = releaseFeedUrl(publicOrigin((n) => h.get(n)), locale);
  const show = Number((await searchParams).show);
  const slice = releaseNotesSlice({
    locale,
    limit: Number.isFinite(show) ? Math.max(show, RELEASE_NOTES_PAGE_SIZE) : RELEASE_NOTES_PAGE_SIZE,
    maxLimit: Number.MAX_SAFE_INTEGER,
  });

  return (
    <PublicShell breadcrumb={{ name: t.releaseNotes.title, path: '/release-notes' }}>
      <div className="max-w-2xl mx-auto my-12 px-4">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-blue-600" /> {t.releaseNotes.title}
          </h1>
          <span className="text-xs text-gray-400">v{APP_VERSION} · {GIT_SHA}</span>
        </div>

        <ReleaseNotesList
          initial={slice.entries}
          total={slice.total}
          pageSize={RELEASE_NOTES_PAGE_SIZE}
          locale={locale}
          labels={{
            loadMore: t.releaseNotes.loadMore,
            shown: t.releaseNotes.shown,
            loadError: t.releaseNotes.loadError,
          }}
        />

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-8">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
            <BrandMark className="h-4 w-4" /> {t.releaseNotes.back}
          </Link>
          <a
            href={feedUrl}
            data-testid="release-notes-feed-link"
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
          >
            <Rss className="h-4 w-4" /> {t.releaseNotes.feed}
          </a>
        </div>
      </div>
    </PublicShell>
  );
}
