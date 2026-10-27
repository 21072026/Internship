'use client';

import { SessionProvider } from 'next-auth/react';
import { LocaleProvider } from '@/i18n/client';
import { ToastProvider } from '@/components/ui/Toast';
import { LiveRegionProvider } from '@/components/ui/LiveRegion';
import { CookieConsent } from '@/components/CookieConsent';
import { FeedbackWidget } from '@/components/FeedbackWidget';
import { SessionTimeoutWarning } from '@/components/SessionTimeoutWarning';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { ActivityTracker } from '@/components/ActivityTracker';
import { ErrorTrackingListener } from '@/components/ErrorTrackingListener';
import { TimezoneSync } from '@/components/TimezoneSync';
import { MeetingLauncherProvider } from '@/components/meeting/MeetingLauncher';
import { FloatingNotesProvider } from '@/components/meeting/FloatingNotes';
import type { Locale } from '@/i18n/config';
import type { ClientDictionary } from '@/i18n/dictionaries';
import type { VerticalKey } from '@/lib/verticals';
import { VerticalProvider } from '@/lib/verticalClient';
import { BrandProvider } from '@/lib/brandClient';
import type { ClientBrand } from '@/lib/brandRule';
import type { ReplayConfig } from '@/lib/feedbackReplayRule';

export function Providers({
  children,
  locale,
  dict,
  vertical,
  brand = null,
  feedbackReplay,
}: {
  children: React.ReactNode;
  locale: Locale;
  /** The shell namespaces only (#2987) — segments add theirs through <I18nScope>. */
  dict: Partial<ClientDictionary>;
  /** The request's vertical (#2501), resolved by the root layout. */
  vertical: VerticalKey;
  /** The request's organization brand (#2922); null = the vertical default. */
  brand?: ClientBrand | null;
  /** Session replay for bug reports (#3131), resolved per request by the root layout. */
  feedbackReplay?: ReplayConfig;
}) {
  return (
    <SessionProvider>
      <LocaleProvider locale={locale} dict={dict}>
      <VerticalProvider vertical={vertical}>
      <BrandProvider brand={brand}>
        {/* WCAG 4.1.3: one live region for the whole app, mounted empty above
            every page shell so it is already in the accessibility tree when the
            first status message arrives (see ui/LiveRegion.tsx). */}
        <LiveRegionProvider>
          <ToastProvider>
            {/* App-wide, above every page shell: an impersonation session has to be
                visible (and reversible) on screens that render their own chrome —
                /messages, /account, /notifications — not just inside ResponsiveShell. */}
            <ImpersonationBanner />
            {/* Above the page shells on purpose: a call in progress has to survive
                navigating from the mentee list to their profile (#1054). */}
            <FloatingNotesProvider>
              <MeetingLauncherProvider>{children}</MeetingLauncherProvider>
            </FloatingNotesProvider>
            <CookieConsent />
            {/* Renders nothing; inert without NEXT_PUBLIC_ERROR_TRACKING (#1600). */}
            <ErrorTrackingListener />
            {/* Signed-in only; renders nothing otherwise (#3130). */}
            <FeedbackWidget replay={feedbackReplay} />
            {/* WCAG 2.2.1: warns five minutes before an idle session ends and
                offers to extend it; signed-in only (#2864). */}
            <SessionTimeoutWarning />
            <ActivityTracker />
            <TimezoneSync />
          </ToastProvider>
        </LiveRegionProvider>
      </BrandProvider>
      </VerticalProvider>
      </LocaleProvider>
    </SessionProvider>
  );
}
