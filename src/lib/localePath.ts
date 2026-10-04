import { defaultLocale, isLocale, locales, type Locale } from '@/i18n/config';
import { PUBLIC_ROUTES } from '@/lib/publicRoutes';

// Language-addressable public URLs (#1386). The language used to live only in a
// cookie, so a search engine saw English alone, a Turkish campaign had no
// Turkish landing URL, and "send me the Turkish version of this page" was not
// a link anyone could share.
//
// The shape: English stays unprefixed (every existing link, e2e assertion and
// share keeps working), Turkish and German live under `/tr` and `/de`. Nothing
// under src/app moved — `src/middleware.ts` REWRITES `/tr/features` to
// `/features` and hands the language over in a request header, so the signed-in
// app keeps its URLs and the remembered-device resume runs unchanged.
//
// Only the public, signed-out pages take a prefix. `/tr/admin` is not a page:
// a dashboard's language is the person's own setting, and a second URL for it
// would only be a second thing to keep working.
//
// Pure and dependency-light on purpose: the middleware (edge runtime) imports
// it, so it may not reach Prisma, next/headers or anything Node-only.

/** Request headers the middleware sets on every page request it passes on. */
export const LOCALE_HEADER = 'x-locale';
/** The page's path WITHOUT a language prefix — what metadata builds URLs from. */
export const LOCALE_PATH_HEADER = 'x-locale-path';

/** The languages that carry a prefix: every one but the default. */
export const PREFIXED_LOCALES = locales.filter((l) => l !== defaultLocale);

/**
 * Split a request path into its language prefix (if any) and the rest.
 * `/tr` → { locale: 'tr', rest: '/' }; `/tr/features` → { locale: 'tr', rest: '/features' };
 * `/features` → { locale: null, rest: '/features' }; `/en/x` → no prefix (English has none).
 */
export function splitLocalePrefix(pathname: string): { locale: Locale | null; rest: string } {
  const match = /^\/([a-z]{2})(\/.*)?$/.exec(pathname);
  if (match && isLocale(match[1]) && match[1] !== defaultLocale) {
    return { locale: match[1], rest: match[2] && match[2] !== '' ? match[2] : '/' };
  }
  return { locale: null, rest: pathname };
}

// The public routes, plus the two families that are public without being
// listed in the sitemap's static half: a showcase project and the stories page
// (both database-backed), and /demo. `/p/<id>` is deliberately not here — a
// public profile is a share link its owner chose, and putting a second language
// of it into an index is the consent question publicRoutes.ts already defers.
const STATIC_PREFIXABLE = new Set<string>([...PUBLIC_ROUTES.map((r) => r.path), '/stories', '/demo']);

/** Whether a (prefix-less) path is a public page that exists in every language. */
export function isPrefixablePath(rest: string): boolean {
  const path = rest.length > 1 ? rest.replace(/\/+$/, '') : rest;
  if (STATIC_PREFIXABLE.has(path)) return true;
  return /^\/projects\/[A-Za-z0-9_-]+$/.test(path);
}

/** The URL path of `rest` in `locale`: unprefixed for the default language. */
export function localizePath(rest: string, locale: Locale): string {
  if (locale === defaultLocale) return rest;
  return rest === '/' ? `/${locale}` : `/${locale}${rest}`;
}

/** `{ en: '/features', tr: '/tr/features', de: '/de/features' }` for one path. */
export function languageAlternates(rest: string): Record<Locale, string> {
  return Object.fromEntries(locales.map((l) => [l, localizePath(rest, l)])) as Record<Locale, string>;
}

/**
 * A same-site link, kept in the language of the URL it is rendered on: on
 * `/tr/…`, `/features` becomes `/tr/features`. Only a public page gets the
 * prefix — `/auth/signin` or `/admin` have no language URL — and an unprefixed
 * (English, or cookie-chosen) page leaves every href as it is.
 */
export function localizeHref(href: string, urlLocale: Locale | null): string {
  if (!urlLocale || urlLocale === defaultLocale || !href.startsWith('/')) return href;
  const match = /^([^?#]*)(.*)$/.exec(href)!;
  if (!isPrefixablePath(match[1])) return href;
  return localizePath(match[1], urlLocale) + match[2];
}
