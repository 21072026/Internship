/**
 * Multi-provider growth analytics framework.
 *
 * Supported providers (all opt-in via env vars — zero trackers ship without
 * explicit configuration):
 *
 *   NEXT_PUBLIC_GA_MEASUREMENT_ID   — Google Analytics 4 (gtag.js)
 *   NEXT_PUBLIC_PLAUSIBLE_DOMAIN    — Plausible Analytics (script auto-loaded)
 *   NEXT_PUBLIC_POSTHOG_KEY         — PostHog (project API key)
 *   NEXT_PUBLIC_POSTHOG_HOST        — PostHog host (default: https://app.posthog.com)
 *
 * Usage (client components / browser only):
 *
 *   import { trackEvent } from '@/lib/analytics';
 *   trackEvent('demo_signup', { source: 'landing' });
 *
 * Usage (server components / SSR):
 *
 *   import { getAnalyticsScripts } from '@/lib/analytics';
 *   // inject the returned <script> snippets into <head>
 *
 * All providers are gated behind GDPR cookie consent: events are silently
 * dropped when `marketing` consent has not been granted (see cookieConsent.ts).
 * Pass `{ force: true }` to bypass the gate for non-PII operational events
 * (e.g. internal health pings) that do not require consent.
 */

export type AnalyticsEvent = {
  /** Canonical snake_case event name. */
  name: string;
  /** Arbitrary key-value payload — must not contain PII. */
  properties?: Record<string, string | number | boolean | null>;
  /**
   * When true the event fires regardless of marketing consent.
   * Only use for non-PII operational events.
   */
  force?: boolean;
};

// ---------------------------------------------------------------------------
// Provider detection (resolved once at module load, client-side only)
// ---------------------------------------------------------------------------

function hasMarketingConsent(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const raw = document.cookie.match(/(?:^|; )cookieConsent=([^;]+)/)?.[1];
    if (!raw) return false;
    const parsed = JSON.parse(decodeURIComponent(raw));
    return parsed?.marketing === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GA4 helpers
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
    posthog?: {
      capture: (event: string, props?: Record<string, unknown>) => void;
      opt_in_capturing: () => void;
      opt_out_capturing: () => void;
    };
    plausible?: (event: string, opts?: { props?: Record<string, string | number | boolean> }) => void;
  }
}

function fireGa4(name: string, properties?: AnalyticsEvent['properties']) {
  if (typeof window === 'undefined' || !window.gtag) return;
  window.gtag('event', name, properties ?? {});
}

// ---------------------------------------------------------------------------
// Plausible helpers
// ---------------------------------------------------------------------------

function firePlausible(name: string, properties?: AnalyticsEvent['properties']) {
  if (typeof window === 'undefined' || !window.plausible) return;
  // Plausible only accepts string | number | boolean — filter out null values.
  const safeProps = properties
    ? (Object.fromEntries(
        Object.entries(properties).filter(([, v]) => v !== null)
      ) as Record<string, string | number | boolean>)
    : {};
  window.plausible(name, { props: safeProps });
}

// ---------------------------------------------------------------------------
// PostHog helpers
// ---------------------------------------------------------------------------

function firePosthog(name: string, properties?: AnalyticsEvent['properties']) {
  if (typeof window === 'undefined' || !window.posthog) return;
  window.posthog.capture(name, properties ?? {});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire an analytics event across all configured providers.
 *
 * Call this from any client component or browser-side code. Server components
 * cannot call it — use the Measurement Protocol / server-side SDKs if you need
 * server-originated events.
 */
export function trackEvent({ name, properties, force = false }: AnalyticsEvent): void {
  if (typeof window === 'undefined') return;
  if (!force && !hasMarketingConsent()) return;

  fireGa4(name, properties);
  firePlausible(name, properties);
  firePosthog(name, properties);
}

/**
 * Convenience wrapper for page view tracking. Call after client-side
 * navigation (e.g. in a `useEffect` that depends on `pathname`).
 */
export function trackPageView(url: string): void {
  trackEvent({ name: 'page_view', properties: { url }, force: false });
}

// ---------------------------------------------------------------------------
// Server-side: return <script> snippet strings to inject into <head>.
// These are pure strings — the caller is responsible for sanitising them
// before injecting into dangerouslySetInnerHTML (they contain only static
// URLs derived from process.env, which are set at build time).
// ---------------------------------------------------------------------------

export interface AnalyticsScripts {
  /** GA4 gtag.js snippet (empty string if unconfigured). */
  ga4: string;
  /** Plausible snippet (empty string if unconfigured). */
  plausible: string;
  /** PostHog snippet (empty string if unconfigured). */
  posthog: string;
}

/**
 * Build the `<script>` snippets for all configured providers.
 * Intended for use in `app/layout.tsx` or a `<head>` server component.
 *
 * All snippets are wrapped in a cookie-consent check so they only activate
 * when the visitor has granted marketing consent, keeping the app GDPR-
 * compliant without a separate consent-mode library.
 */
export function getAnalyticsScripts(): AnalyticsScripts {
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? '';
  const plausibleDomain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ?? '';
  const phKey = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';
  const phHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://app.posthog.com';

  const ga4 = gaId
    ? `
(function(){
  var c=document.cookie.match(/(?:^|; )cookieConsent=([^;]+)/);
  try{var p=c?JSON.parse(decodeURIComponent(c[1])):null;}catch(e){return;}
  if(!p||!p.marketing)return;
  var s=document.createElement('script');
  s.src='https://www.googletagmanager.com/gtag/js?id=${gaId}';
  s.async=true;
  document.head.appendChild(s);
  window.dataLayer=window.dataLayer||[];
  function gtag(){dataLayer.push(arguments);}
  window.gtag=gtag;
  gtag('js',new Date());
  gtag('config','${gaId}',{anonymize_ip:true});
})();`.trim()
    : '';

  const plausible = plausibleDomain
    ? `
(function(){
  var c=document.cookie.match(/(?:^|; )cookieConsent=([^;]+)/);
  try{var p=c?JSON.parse(decodeURIComponent(c[1])):null;}catch(e){return;}
  if(!p||!p.marketing)return;
  var s=document.createElement('script');
  s.defer=true;
  s.setAttribute('data-domain','${plausibleDomain}');
  s.src='https://plausible.io/js/plausible.js';
  document.head.appendChild(s);
})();`.trim()
    : '';

  const posthog = phKey
    ? `
(function(){
  var c=document.cookie.match(/(?:^|; )cookieConsent=([^;]+)/);
  try{var p=c?JSON.parse(decodeURIComponent(c[1])):null;}catch(e){return;}
  if(!p||!p.marketing)return;
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]);t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString()+" (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('${phKey}',{api_host:'${phHost}',persistence:'localStorage'});
})();`.trim()
    : '';

  return { ga4, plausible, posthog };
}
