/**
 * Growth Analytics & Conversion Tracking Module
 * Safe client-side wrapper for firing growth events across multiple analytics providers
 * (Google Analytics 4, PostHog, Meta Pixel, LinkedIn Insight Tag).
 */

export type TrackEventName =
  | 'landing_page_viewed'
  | 'demo_started'
  | 'demo_role_switched'
  | 'register_initiated'
  | 'register_completed'
  | 'profile_shared_linkedin'
  | 'profile_shared_twitter'
  | 'b2b_lead_initiated'
  | 'pricing_plan_clicked';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: { capture: (event: string, properties?: Record<string, unknown>) => void };
    fbq?: (...args: unknown[]) => void;
    lintrk?: (action: string, data: { conversion_id: number | string }) => void;
  }
}

export function trackEvent(eventName: TrackEventName | string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;

  // 1. Log in dev mode for debugging
  if (process.env.NODE_ENV === 'development') {
    console.log(`[Analytics Event]: ${eventName}`, properties || '');
  }

  // 2. Google Analytics 4 (GA4)
  if (typeof window.gtag === 'function') {
    try {
      window.gtag('event', eventName, properties);
    } catch (err) {
      console.warn('GA4 track error', err);
    }
  }

  // 3. PostHog Analytics
  if (window.posthog && typeof window.posthog.capture === 'function') {
    try {
      window.posthog.capture(eventName, properties);
    } catch (err) {
      console.warn('PostHog track error', err);
    }
  }

  // 4. Meta Pixel (Facebook)
  if (typeof window.fbq === 'function') {
    try {
      window.fbq('trackCustom', eventName, properties);
    } catch (err) {
      console.warn('Meta Pixel track error', err);
    }
  }
}
