import { cookies } from 'next/headers';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './config';
import { getDictionary } from './dictionaries';

// Read the active locale from the cookie (server components).
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : defaultLocale;
}

export async function getServerDictionary() {
  const locale = await getLocale();
  return { locale, t: getDictionary(locale) };
}
