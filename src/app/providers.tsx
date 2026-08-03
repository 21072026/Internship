'use client';

import { SessionProvider } from 'next-auth/react';
import { LocaleProvider } from '@/i18n/client';
import { ToastProvider } from '@/components/ui/Toast';
import { CookieConsent } from '@/components/CookieConsent';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { ActivityTracker } from '@/components/ActivityTracker';
import { TimezoneSync } from '@/components/TimezoneSync';
import { MeetingLauncherProvider } from '@/components/meeting/MeetingLauncher';
import type { Locale } from '@/i18n/config';
import type { ClientDictionary } from '@/i18n/dictionaries';

export function Providers({
  children,
  locale,
  dict,
}: {
  children: React.ReactNode;
  locale: Locale;
  dict: ClientDictionary;
}) {
  return (
    <SessionProvider>
      <LocaleProvider locale={locale} dict={dict}>
        <ToastProvider>
          {/* App-wide, above every page shell: an impersonation session has to be
              visible (and reversible) on screens that render their own chrome —
              /messages, /account, /notifications — not just inside ResponsiveShell. */}
          <ImpersonationBanner />
          {/* Above the page shells on purpose: a call in progress has to survive
              navigating from the mentee list to their profile (#1054). */}
          <MeetingLauncherProvider>{children}</MeetingLauncherProvider>
          <CookieConsent />
          <ActivityTracker />
          <TimezoneSync />
        </ToastProvider>
      </LocaleProvider>
    </SessionProvider>
  );
}
