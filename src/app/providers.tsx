'use client';

import { SessionProvider } from 'next-auth/react';
import { LocaleProvider } from '@/i18n/client';
import { CookieConsent } from '@/components/CookieConsent';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries';

export function Providers({
  children,
  locale,
  dict,
}: {
  children: React.ReactNode;
  locale: Locale;
  dict: Dictionary;
}) {
  return (
    <SessionProvider>
      <LocaleProvider locale={locale} dict={dict}>
        {children}
        <CookieConsent />
      </LocaleProvider>
    </SessionProvider>
  );
}
