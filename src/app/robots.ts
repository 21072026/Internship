import type { MetadataRoute } from 'next';
import { APP_ENV } from '@/lib/appEnv';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import { siteUrl } from '@/lib/siteUrl';

// /robots.txt (#1380). Same file convention as manifest.ts — Next serves this
// at /robots.txt, so no route handler is needed.
//
// Read at request time rather than prerendered: the `Sitemap:` line has to be
// absolute, and the origin comes from NEXTAUTH_URL, which is a runtime variable
// (see lib/siteUrl.ts).
export const dynamic = 'force-dynamic';

/**
 * Prefixes a crawler has no business fetching. None of them are a security
 * boundary — every one of them redirects to sign-in — but each crawled URL
 * spends crawl budget on a login redirect and can surface as a meaningless
 * search result.
 *
 * Written as an exact-or-subpath pair (`/x$`, `/x/`) rather than the bare
 * prefix `/x`, because `Disallow` matches by prefix: a plain `/mentor` would
 * also swallow `/mentors`, the *public* mentor directory. `$` is the Google /
 * Bing end-anchor extension; the `/x/` line is what a crawler that ignores the
 * anchor still honours, so the worst case is one dashboard URL being fetched
 * and redirected to sign-in.
 */
const PROTECTED_PATHS = [
  '/admin',
  '/mentor',
  '/portal',
  '/company',
  '/messages',
  '/account',
  '/notifications',
  '/todos',
  '/onboarding',
  '/interviews',
  '/weekly-reports',
  '/newsletter',
  '/newsletters',
  '/testimonials',
  '/re-engage',
  '/consent',
  '/security-setup',
  '/source',
  '/offline',
  '/rsvp',
  '/m',
  '/u',
];

// Prefixes with no public sibling to protect, so the plain prefix is enough.
const PROTECTED_PREFIXES = ['/api/', '/auth/'];

export default function robots(): MetadataRoute.Robots {
  // Preview, the per-PR topic environments and the public demo all serve the
  // same content as production. Indexing them would put three or four copies
  // of every page in the index and let a search result drop a visitor into a
  // throwaway environment, so they are closed entirely — and a blanket
  // disallow deliberately carries no `Sitemap:` line, which would contradict
  // it.
  if (APP_ENV !== 'production' || IS_DEMO_MODE) {
    return { rules: { userAgent: '*', disallow: '/' } };
  }

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [...PROTECTED_PATHS.flatMap((p) => [`${p}$`, `${p}/`]), ...PROTECTED_PREFIXES],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
