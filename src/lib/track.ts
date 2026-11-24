/**
 * Consent-aware conversion sender for public pages (#1391, #1388).
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
 *   Only finite facts about the UI: which role or placement was selected.
 *   Never a user id, an e-mail, a name or anything read out of a session —
 *   Public controls emit anonymous categories even when the browser already
 *   has a CRM session. No session or form data belongs in this API.
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
import { ANALYTICS_EVENTS, safeEventProps, type AnalyticsEvent, type EventProps, type ExactEventProps } from '@/lib/analyticsEvents';
export { ANALYTICS_EVENTS } from '@/lib/analyticsEvents';
export type { EventProps } from '@/lib/analyticsEvents';

/** Finite, non-identifying categories; no free-form property bag. */
// The finite EventProps contract lives beside the stable event names.

interface AnalyticsGlobals {
  plausible?: (event: AnalyticsEvent, opts?: { props?: EventProps }) => void;
  gtag?: (command: 'event', name: AnalyticsEvent, params?: EventProps & { transport_type?: 'beacon' }) => void;
  posthog?: {
    capture?: (name: AnalyticsEvent, props?: EventProps, opts?: { transport?: 'XHR' | 'sendBeacon' }) => void;
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
export function track<P extends EventProps = EventProps>(name: AnalyticsEvent, props?: ExactEventProps<P>): boolean {
  if (typeof window === 'undefined') return false;
  if (!hasConsent('analytics')) return false;

  if (!(Object.values(ANALYTICS_EVENTS) as readonly string[]).includes(name)) return false;
  let safe: EventProps;
  try { safe = safeEventProps(props ?? {}); } catch { return false; }
  const w = window as unknown as AnalyticsGlobals;
  try {
    if (typeof w.plausible !== 'function' && typeof w.gtag !== 'function' && typeof w.posthog?.capture !== 'function') return false;
    // Auth URLs can contain invitation/verification credentials. Only after
    // success may those consumed parameters be removed. If the browser cannot
    // clear them, drop telemetry, never fail the completed business operation.
    if ((name === ANALYTICS_EVENTS.SIGNUP_COMPLETED || name === ANALYTICS_EVENTS.SIGNUP_VERIFIED) && (window.location.search || window.location.hash)) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  } catch { return false; }
  let sent = false;

  try {
    if (w.plausible) { w.plausible(name, { props: { ...safe } }); sent = true; }
  } catch {
    /* ignore */
  }
  try {
    if (w.gtag) { w.gtag('event', name, { ...safe, transport_type: 'beacon' }); sent = true; }
  } catch {
    /* ignore */
  }
  try {
    if (w.posthog?.capture) { w.posthog.capture(name, { ...safe }, { transport: 'sendBeacon' }); sent = true; }
  } catch {
    /* ignore */
  }
  return sent;
}
