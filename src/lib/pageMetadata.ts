import type { Metadata } from 'next';
import { getServerDictionary } from '@/i18n/server';
import type { Dictionary } from '@/i18n/dictionaries';

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

/** Metadata for a public page, picked from the active locale's dictionary. */
export async function pageMetadata(pick: (t: Dictionary) => PageCopy): Promise<Metadata> {
  const { t } = await getServerDictionary();
  const { title, description } = pick(t);
  return description ? { title, description } : { title };
}

/**
 * The signed-in areas (#1376). robots.txt already disallows their prefixes,
 * but a disallowed URL can still be indexed from a link — only a `noindex` on
 * the page itself keeps it out of the results, so every protected segment's
 * layout carries this too.
 */
export const NO_INDEX: Metadata = { robots: { index: false, follow: false } };
