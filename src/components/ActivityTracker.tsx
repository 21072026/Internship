'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';

// Consent-gated page-view + dwell-time tracker. Mounted once globally (in
// Providers); self-gates on an authenticated session AND the user's
// ACTIVITY_TRACKING consent. On each route change it reports the page just left
// and how long it was open; a hidden/unload beacon flushes the final page. The
// server (/api/track/pageview) re-checks consent, so nothing is stored unless
// the user opted in. Feeds the mentee activity report.
export function ActivityTracker() {
  const { status } = useSession();
  const pathname = usePathname();
  const consented = useRef(false);
  const currentPath = useRef<string | null>(null);
  const enteredAt = useRef<number>(0);

  // Learn whether this user opted into tracking (once per mount).
  useEffect(() => {
    if (status !== 'authenticated') {
      consented.current = false;
      return;
    }
    let cancelled = false;
    fetch('/api/consent')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) consented.current = !!d?.consents?.ACTIVITY_TRACKING;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status]);

  const send = (path: string | null, enteredMs: number) => {
    if (!consented.current || !path) return;
    const durationSec = Math.max(0, Math.round((Date.now() - enteredMs) / 1000));
    const body = JSON.stringify({ path, durationSec });
    try {
      // sendBeacon survives page unload; fall back to keepalive fetch.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track/pageview', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/track/pageview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
      }
    } catch {
      /* ignore */
    }
  };

  // Report the previous page (with its dwell) whenever the path changes.
  useEffect(() => {
    if (status !== 'authenticated') return;
    if (currentPath.current && currentPath.current !== pathname) {
      send(currentPath.current, enteredAt.current);
    }
    currentPath.current = pathname;
    enteredAt.current = Date.now();
  }, [pathname, status]);

  // Flush the current page when the tab is hidden or the page is unloaded.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const flush = () => {
      send(currentPath.current, enteredAt.current);
      enteredAt.current = Date.now(); // avoid double-counting if it becomes visible again
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else enteredAt.current = Date.now();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [status]);

  return null;
}
