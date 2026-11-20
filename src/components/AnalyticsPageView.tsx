'use client';
import { useEffect, useRef } from 'react';
import { track } from '@/lib/track';
import { ANALYTICS_READY_EVENT, type AnalyticsEvent } from '@/lib/analyticsEvents';
import { COOKIE_CONSENT_EVENT } from '@/lib/cookieConsent';

/** Observe this mounted public page once, including an asynchronously loaded SDK. */
export function AnalyticsPageView({ event }: { event: AnalyticsEvent }) {
  const sent = useRef(false);
  useEffect(() => {
    const send = () => { if (!sent.current) sent.current = track(event); };
    send();
    window.addEventListener(ANALYTICS_READY_EVENT, send);
    window.addEventListener(COOKIE_CONSENT_EVENT, send);
    return () => {
      window.removeEventListener(ANALYTICS_READY_EVENT, send);
      window.removeEventListener(COOKIE_CONSENT_EVENT, send);
    };
  }, [event]);
  return null;
}
