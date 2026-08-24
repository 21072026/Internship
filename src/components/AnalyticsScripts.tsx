'use client';

import { useEffect, useState } from 'react';
import { configuredProviders } from '@/lib/analytics';
import { COOKIE_CONSENT_EVENT, hasConsent } from '@/lib/cookieConsent';

/**
 * Loads the configured analytics providers — and only for a visitor who said
 * yes (#1242).
 *
 * Mounted from the PUBLIC shell, never from the root layout. That is the whole
 * point of the earlier review: injected at the root, these scripts would also
 * run on the signed-in CRM, where "a pageview" means a mentee's name in a URL
 * and a third party watching an admin work. Growth measurement belongs on the
 * pages that market the product.
 *
 * The consent is re-read on the consent-change event, so accepting in the
 * banner starts measurement without a reload — and, more importantly,
 * withdrawing stops mattering immediately for anything loaded later.
 */
export function AnalyticsScripts() {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const read = () => setAllowed(hasConsent('analytics'));
    read();
    window.addEventListener(COOKIE_CONSENT_EVENT, read);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, read);
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const added: HTMLScriptElement[] = [];
    for (const provider of configuredProviders()) {
      if (document.querySelector(`script[data-analytics="${provider.id}"]`)) continue;
      if (provider.snippet.src) {
        const s = document.createElement('script');
        s.src = provider.snippet.src;
        s.async = true;
        s.dataset.analytics = provider.id;
        for (const [k, v] of Object.entries(provider.snippet.attrs ?? {})) s.setAttribute(k, v);
        document.head.appendChild(s);
        added.push(s);
        if (provider.snippet.inline) {
          // After the loader, so `gtag`/`posthog` exist when it runs.
          s.addEventListener('load', () => {
            const i = document.createElement('script');
            i.dataset.analyticsInit = provider.id;
            i.textContent = provider.snippet.inline!;
            document.head.appendChild(i);
          });
        }
      }
    }
    // No cleanup that removes the tags: a provider already loaded cannot be
    // un-loaded from the page, and pretending otherwise would be theatre. What
    // withdrawal does is stop the NEXT page from loading them, which is what
    // the event listener above is for.
    return () => { added.forEach((s) => { /* left in place deliberately */ void s; }); };
  }, [allowed]);

  return null;
}
