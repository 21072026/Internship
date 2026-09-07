/**
 * One-line custom-event sender for the public marketing pages (#1391).
 *
 * WHAT IT IS NOT
 *   It is not a new analytics vendor and it loads nothing. The only transports
 *   it uses are the provider globals that `AnalyticsScripts` already put on the
 *   page after the visitor accepted analytics cookies (`src/lib/analytics.ts`).
 *   A public page that publishes data-protection promises (`/trust`) cannot grow
 *   a second beacon without that being a legal decision rather than a code one,
 *   so this file deliberately has no fetch, no image pixel and no endpoint of
 *   its own.
 *
 * WHY NOT /api/track/pageview
 *   That route is the signed-in dwell-time tracker: it needs `session.user.id`
 *   and stores a `PageView` row against it. The landing page is anonymous, and
 *   an anonymous visitor has no row to write — which is the right answer, not a
 *   gap to fill.
 *
 * WHAT MAY BE PASSED
 *   Only facts about the page: which control was used, which target it points
 *   at. Never a user id, an e-mail, a name or anything read out of a session —
 *   these events come from a page where nobody is signed in, and they must stay
 *   that way even after someone mounts this on an authenticated screen.
 *
 * SURVIVING THE UNLOAD
 *   Called from an `onClick` handler the event is queued before the browser
 *   starts navigating, and the two providers that support it are asked for a
 *   beacon transport (GA4 `transport_type`, PostHog `transport`), which the
 *   browser keeps in flight across the unload. Plausible's script has no such
 *   option and posts over XHR, so on a same-tab navigation its delivery is
 *   best-effort. That residual gap is why the UTM parameters exist as well: the
 *   receiving side sees the campaign even when the sender-side event is lost.
 */

import { hasConsent } from '@/lib/cookieConsent';

/** Event properties: scalars describing the page, never a person. */
export type EventProps = Record<string, string | number | boolean>;

interface AnalyticsGlobals {
  plausible?: (event: string, opts?: { props?: EventProps }) => void;
  gtag?: (command: 'event', name: string, params?: Record<string, unknown>) => void;
  posthog?: {
    capture?: (name: string, props?: EventProps, opts?: { transport?: 'XHR' | 'sendBeacon' }) => void;
  };
}

/**
 * Send a custom event to whichever analytics providers are loaded.
 *
 * A no-op when there is no window, when analytics consent was not given, and
 * when no provider is configured — in that order, so the common case (no
 * consent) costs one localStorage read and nothing else. Each provider is
 * called in its own try/catch: a vendor script that throws must not swallow the
 * others, and telemetry must never break a navigation.
 */
export function track(name: string, props: EventProps = {}): void {
  if (typeof window === 'undefined') return;
  if (!hasConsent('analytics')) return;

  const w = window as unknown as AnalyticsGlobals;

  try {
    w.plausible?.(name, { props });
  } catch {
    /* ignore */
  }
  try {
    w.gtag?.('event', name, { ...props, transport_type: 'beacon' });
  } catch {
    /* ignore */
  }
  try {
    w.posthog?.capture?.(name, props, { transport: 'sendBeacon' });
  } catch {
    /* ignore */
  }
}
