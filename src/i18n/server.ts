import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './config';
import { getDictionary } from './dictionaries';
import { applyVerticalOverlay } from './verticalOverlays';
import { toVerticalKey, type VerticalKey } from '@/lib/verticals';
import { hostVertical } from '@/lib/hostVertical';

// Read the active locale. An explicit cookie (set via the language switcher)
// always wins; otherwise fall back to the signed-in user's saved preference,
// then the default. Any failure degrades gracefully to the default locale.
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(v)) return v;

  // A signed-out visitor has no saved preference to fall back to, so the session
  // decode and the query behind it would both come back empty. Every public page
  // goes through here, so that is a round trip per view for nothing (#1197).
  if (!(await hasSessionCookie())) return defaultLocale;

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
    // ignore — fall through to default
  }
  return defaultLocale;
}

// The signed-in user's tenant vertical, or INTERNSHIP for a signed-out visitor
// (and any failure). One indexed lookup, and only when a session cookie is
// present — a public view resolves to the default with no query, so the overlay
// layer costs the live single-tenant product nothing (#1197).
export async function resolveRequestVertical(): Promise<VerticalKey> {
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
}

export async function getServerDictionary() {
  const locale = await getLocale();
  const vertical = await resolveRequestVertical();
  return { locale, t: applyVerticalOverlay(getDictionary(locale), locale, vertical) };
}
