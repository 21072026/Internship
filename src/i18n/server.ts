import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { defaultLocale, isLocale, LOCALE_COOKIE, locales, type Locale } from './config';
import { pickAcceptLanguage } from './acceptLanguage';
import { getDictionary } from './dictionaries';
import { applyVerticalOverlay } from './verticalOverlays';
import { toVerticalKey, type VerticalKey } from '@/lib/verticals';
import { hostVertical } from '@/lib/hostVertical';

// Read the active locale, in this order (#1384):
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
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(v)) return v;

  // A signed-out visitor has no saved preference to fall back to, so the session
  // decode and the query behind it would both come back empty. Every public page
  // goes through here, so that is a round trip per view for nothing (#1197).
  // The header read below costs neither.
  if (!(await hasSessionCookie())) return browserLocale();

  try {
    const session = await getServerSession(authOptions);
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
    const session = await getServerSession(authOptions);
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

export async function getServerDictionary() {
  const locale = await getLocale();
  const vertical = await resolveRequestVertical();
  return { locale, t: applyVerticalOverlay(getDictionary(locale), locale, vertical) };
}
