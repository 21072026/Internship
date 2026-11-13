/**
 * Growth analytics, provider-agnostic and off by default (#1242, #966).
 *
 * Pure and dependency-free: no SDK is bundled. Each provider is a small script
 * tag we emit only when BOTH of two independent things are true —
 *
 *   1. the operator configured it (its env var is set), and
 *   2. the visitor accepted analytics cookies.
 *
 * Two gates rather than one because they answer different questions. The env
 * decides whether this deployment has an analytics vendor at all; the consent
 * decides whether THIS person is measured. Neither implies the other, and an
 * integration that treats "configured" as permission is how a CRM ends up
 * shipping mentee behaviour to a third party.
 */

// The host table lives in the .cjs sibling because next.config.js has to read
// it before any TS toolchain exists. Importing it back here is what keeps it
// ONE list instead of two that drift.
import { analyticsCspHosts as cspHosts } from '@/lib/analyticsCsp.cjs';

export type ProviderId = 'plausible' | 'ga4' | 'posthog';

/** The globals the providers' loaders define, as far as `init` touches them. */
export type AnalyticsWindow = {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  posthog?: { init?: (key: string, options: Record<string, unknown>) => void };
};

export interface AnalyticsProvider {
  id: ProviderId;
  /**
   * The <script> to inject once consent is given, and what to call once it has
   * loaded. `init` is a function, never script text: under the strict CSP
   * (#1552, docs/csp.md) an inline <script> we insert carries no nonce and is
   * blocked — 'strict-dynamic' trusts inserted EXTERNAL scripts only.
   */
  snippet: { src?: string; init?: (w: AnalyticsWindow) => void; attrs?: Record<string, string> };
}

/**
 * Which providers this deployment has configured.
 *
 * Reads NEXT_PUBLIC_* on purpose: these are inlined at build time, which is
 * what lets `next.config.js` narrow the CSP to exactly the providers in use.
 * (The JaaS host next to it cannot do that — its credentials only exist at
 * runtime, so its host is listed unconditionally. The difference is worth
 * knowing before someone "tidies" the two into one shape.)
 */
export function configuredProviders(env: Record<string, string | undefined> = process.env): AnalyticsProvider[] {
  const out: AnalyticsProvider[] = [];

  const plausibleDomain = env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
  if (plausibleDomain) {
    const host = env.NEXT_PUBLIC_PLAUSIBLE_HOST || 'https://plausible.io';
    out.push({
      id: 'plausible',
      snippet: { src: `${host.replace(/\/$/, '')}/js/script.js`, attrs: { 'data-domain': plausibleDomain, defer: 'true' } },
    });
  }

  const ga4 = env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  if (ga4) {
    out.push({
      id: 'ga4',
      snippet: {
        src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4)}`,
        init: (w) => {
          const dataLayer = (w.dataLayer = w.dataLayer || []);
          // gtag.js reads `arguments` objects off the data layer, not arrays —
          // the same function as Google's snippet, without the inline <script>.
          w.gtag = function gtag() {
            // eslint-disable-next-line prefer-rest-params
            dataLayer.push(arguments);
          };
          w.gtag('js', new Date());
          w.gtag('config', ga4, { anonymize_ip: true });
        },
      },
    });
  }

  const posthogKey = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (posthogKey) {
    const host = env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';
    out.push({
      id: 'posthog',
      snippet: {
        src: `${host.replace(/\/$/, '')}/static/array.js`,
        // autocapture and persistence are OFF. PostHog's defaults record every
        // click and keep an id in localStorage; on a CRM that is mentee
        // behaviour and mentee identity going to a third party. Growth
        // measurement needs pageviews on public pages, not that.
        init: (w) =>
          w.posthog?.init?.(posthogKey, {
            api_host: host,
            autocapture: false,
            persistence: 'memory',
            disable_session_recording: true,
            capture_pageview: true,
          }),
      },
    });
  }

  return out;
}

/** CSP fragments for the configured providers — empty when none is configured. */
export function analyticsCspHosts(env: Record<string, string | undefined> = process.env) {
  return cspHosts(env);
}
