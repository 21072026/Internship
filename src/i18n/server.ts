import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { requestSession } from '@/lib/requestSession';
import { prisma } from '@/lib/prisma';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { defaultLocale, isLocale, LOCALE_COOKIE, locales, type Locale } from './config';
import { pickAcceptLanguage } from './acceptLanguage';
import { LOCALE_HEADER } from '@/lib/localePath';
import { getDictionary } from './dictionaries';
import { applyVerticalOverlay } from './verticalOverlays';
import { toVerticalKey, type VerticalKey } from '@/lib/verticals';
import { hostVertical } from '@/lib/hostVertical';
import { requestProductName } from '@/lib/hostBrand';

// Read the active locale, in this order (#1384, #1386):
//   0. the language of the URL — `/tr/…` and `/de/…` are rewritten by
//      src/middleware.ts, which passes the prefix on as the `x-locale` request
//      header (the middleware strips any inbound copy, so a client cannot set
//      it). A language URL is a promise: a shared Turkish link opens in Turkish
//      whatever cookie the reader has;
//   1. the explicit cookie the language switcher sets — a choice always wins;
//   2. the signed-in user's saved preference — also their own decision;
//   3. the browser's Accept-Language — what the visitor reads, before they
//      have said anything (a Turkish ad opened in English was the bug);
//   4. the default.
// Nothing here writes the cookie: step 3 is re-read on every request, and the
// cookie stays the record of an explicit choice. Any failure degrades to the
// next step.
//
// CACHING: one URL now answers in several languages. That is safe only because
// every page is served `Cache-Control: private, no-store` (Next's default for
// these dynamic routes), so no shared cache ever stores one visitor's language
// for the next. A `Vary: Accept-Language` cannot be added from the app on Next
// 15.5 — its app-page handler `setHeader('Vary', …)`s over both a middleware
// value and a next.config `headers()` value (verified against `next start`).
// e2e/accept-language.spec.ts pins the no-store; if pages ever become publicly
// cacheable, add the Vary at the proxy (Caddy `header +Vary Accept-Language`).
export async function getLocale(): Promise<Locale> {
  const fromUrl = await urlLocale();
  if (fromUrl) return fromUrl;

  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(v)) return v;

  // A signed-out visitor has no saved preference to fall back to, so the session
  // decode and the query behind it would both come back empty. Every public page
  // goes through here, so that is a round trip per view for nothing (#1197).
  // The header read below costs neither.
  if (!(await hasSessionCookie())) return browserLocale();

  try {
    const session = await requestSession();
    if (session?.user?.id) {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { preferredLanguage: true },
      });
      if (user && isLocale(user.preferredLanguage ?? undefined)) {
        return user.preferredLanguage as Locale;
      }
    }
  } catch {
    // ignore — fall through to the browser's languages
  }
  return browserLocale();
}

// Step 0: the URL's language prefix, as the middleware handed it over. Null
// outside a request (a script, a cron render) and on every unprefixed URL.
// Exported for the public chrome, which keeps its links in the URL's language.
export async function urlLocale(): Promise<Locale | null> {
  try {
    const v = (await headers()).get(LOCALE_HEADER);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

// Step 3: the request's Accept-Language, or the default. `headers()` is the
// incoming request, so this is free — no session, no query.
async function browserLocale(): Promise<Locale> {
  try {
    return pickAcceptLanguage((await headers()).get('accept-language'), locales) ?? defaultLocale;
  } catch {
    // Outside a request (a script, a cron render): there is no browser.
    return defaultLocale;
  }
}

// The signed-in user's tenant vertical, or the HOST's product for a signed-out
// visitor (and any failure). One indexed lookup, and only when a session cookie
// is present — a public view resolves from the host with no query, so the
// overlay layer costs the live single-tenant product nothing (#1197).
//
// WORLDS (#2590) — why the two branches below can never disagree. The rule is
// "the URL you signed in on decides the product": one person can hold an account
// in each world, and the host says which. The session callback in
// src/lib/auth.ts enforces that on EVERY request — a session whose organization's
// vertical differs from the host it is presented on is returned as null. So by
// the time `getServerSession()` below yields a user, that user's org vertical IS
// the host's vertical (the guard is recomputed from the org's CURRENT vertical on
// every request, so an organization moved to the other product stops matching at
// once; its only blind spot is a request with no host to read, where it fails
// open). A mismatched session falls through to the `!session?.user?.id` branch
// and the copy follows the host, exactly like a signed-out visitor's. So the
// lookup still reads the org's vertical — the org, not the host, is the source
// of truth for a signed-in person, and it keeps the overlay right where no host
// header exists (a cron render, a script) — and the host never has to be
// re-asked here.
//
// Wrapped in React's per-request cache() (#2492): the root layout asks for the
// vertical from generateMetadata, generateViewport and its body, and PublicShell
// and the footer ask again — one session decode + one Prisma lookup per request,
// not five.
export const resolveRequestVertical = cache(async (): Promise<VerticalKey> => {
  // Signed OUT (a public page — the landing, /apply, /for-companies): the only
  // signal is the request host, so two urls serve two products' copy from one
  // deployment (#2355). No query.
  if (!(await hasSessionCookie())) return hostVertical();
  try {
    const session = await requestSession();
    // No VALID identity (a stale/expired/revoked cookie decodes to no user) is
    // still "signed out" for this purpose, so the vertical is a host signal —
    // otherwise a marketing-host visitor with a leftover cookie sees the
    // internship landing (#2355 review).
    if (!session?.user?.id) return hostVertical();
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { org: { select: { vertical: true } } },
    });
    return toVerticalKey(user?.org?.vertical);
  } catch {
    // A transient session/DB error is not a reason to override the host's
    // product with the default one; fall back to the host signal.
    return hostVertical();
  }
});

// The page's dictionary: the base translation with the request's vertical
// overlay, the overlay's `{product}` filled with the product name this page
// prints (#2936) — the request brand's (the signed-in person's organization,
// else the host's), never another vertical's. `product` is returned too, for a
// base string that carries the same token (the landing FAQ, wrongWorld, …).
export async function getServerDictionary() {
  const locale = await getLocale();
  const vertical = await resolveRequestVertical();
  const product = await requestProductName(vertical);
  return { locale, product, t: applyVerticalOverlay(getDictionary(locale), locale, vertical, { product }) };
}
