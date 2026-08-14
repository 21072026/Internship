import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasSessionCookie } from '@/lib/sessionCookie';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './config';
import { getDictionary } from './dictionaries';

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

export async function getServerDictionary() {
  const locale = await getLocale();
  return { locale, t: getDictionary(locale) };
}
