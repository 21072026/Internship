import type { Metadata } from 'next';
import { getServerDictionary, resolveRequestVertical } from '@/i18n/server';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { productNameFor } from '@/lib/verticals';

// Every public page's own tab title and search snippet, in the reader's
// language (#1376). Before this the whole site carried the root layout's one
// English title and description, so /features, /privacy and /projects were
// indistinguishable in a search result and a Turkish page wore an English tab.
//
// The TITLE is the page's own H1 string wherever it has one, read from the
// same dictionary key the H1 renders, so the tab and the heading cannot drift;
// `seo` only holds what a page has nowhere else. The product name is NOT added
// here: the root layout's title template appends it for the request's vertical
// (#2498), which is why a page must never build "X — Internship CRM" itself.

export type PageCopy = { title: string; description?: string };

const OG_LOCALE: Record<Locale, string> = { en: 'en_US', tr: 'tr_TR', de: 'de_DE' };

/**
 * The share-card half (#1378): what LinkedIn, WhatsApp, Slack and X show for
 * a link. Built from the same copy as the tab title, so a shared link reads
 * like the page. `card` is the image route to show: the root card
 * (src/app/opengraph-image.tsx) unless the page has one of its own. It is
 * always named explicitly: a page that sets `openGraph` stops inheriting its
 * ancestors' file-based image (checked against `next start`: /privacy shared
 * as a bare link), and naming the route keeps the result independent of how
 * Next merges file-based and config images. `metadataBase` makes it absolute.
 */
export const DEFAULT_CARD = '/opengraph-image';

export async function socialMetadata(
  copy: PageCopy,
  card: string = DEFAULT_CARD
): Promise<Pick<Metadata, 'openGraph' | 'twitter'>> {
  const [{ locale }, vertical] = await Promise.all([getServerDictionary(), resolveRequestVertical()]);
  return {
    openGraph: {
      type: 'website',
      siteName: productNameFor(vertical),
      locale: OG_LOCALE[locale],
      title: copy.title,
      ...(copy.description ? { description: copy.description } : {}),
      images: [{ url: card, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: copy.title,
      ...(copy.description ? { description: copy.description } : {}),
      images: [card],
    },
  };
}

/**
 * Metadata for a public page, picked from the active locale's dictionary.
 * `card`: the page's own `opengraph-image` route, when it has one.
 */
export async function pageMetadata(pick: (t: Dictionary) => PageCopy, card?: string): Promise<Metadata> {
  const { t } = await getServerDictionary();
  const copy = pick(t);
  return {
    title: copy.title,
    ...(copy.description ? { description: copy.description } : {}),
    ...(await socialMetadata(copy, card)),
  };
}

/**
 * The signed-in areas (#1376). robots.txt already disallows their prefixes,
 * but a disallowed URL can still be indexed from a link — only a `noindex` on
 * the page itself keeps it out of the results, so every protected segment's
 * layout carries this too.
 */
export const NO_INDEX: Metadata = { robots: { index: false, follow: false } };
