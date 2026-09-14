'use client';

import { useEffect } from 'react';

/**
 * Registers `/sw.js` for every visitor (#1550). Renders nothing.
 *
 * WHY IT IS NOT IN InstallAppButton ANY MORE: that component lives in the
 * signed-in role sidebars, so the registration only ever happened *behind
 * login*. Everything the worker provides — the offline fallback at `/offline`,
 * the precached shell, the `beforeinstallprompt` event an installable PWA needs
 * — was therefore invisible to a visitor on the landing page, which is exactly
 * the audience the landing page advertises installability to. Mounted from the
 * root layout, the worker is registered on the first public page view instead.
 *
 * Registration is idempotent, so `pushNotifications.ts` calling `register()`
 * again when someone enables notifications is still fine.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // After first paint rather than during it: the registration fetch competes
    // with the page's own requests for nothing — the worker only ever controls
    // the *next* load anyway.
    const id = window.setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  return null;
}
