// Core Web Vitals (#1593) — the rules, dependency-free and client-safe so the
// browser reporter, the relay route and the unit test share them.
//
// What a sample may carry: the metric name, its value, Google's rating band and
// a route TEMPLATE — the path with its query dropped and every id-like segment
// replaced by `[id]`, so `/admin/candidates/clx9…` and `/admin/candidates/clz2…`
// are one row in a report and no record id leaves the browser. Nothing else: no
// user, no session, no user agent, no URL query.

import { maskUrl } from './feedbackContext';

export const WEB_VITAL_NAMES = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'] as const;
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];
export const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const;

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[a-z0-9]{20,}|:token)$/i;

/** `/admin/candidates/clx9abc…?tab=cv` → `/admin/candidates/[id]`. */
export function routeTemplate(path: string): string {
  const masked = maskUrl(path || '/').split('?', 1)[0];
  const pathname = masked.startsWith('/') ? masked : new URL(masked, 'http://x.invalid').pathname;
  const out = pathname
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? '[id]' : seg))
    .join('/');
  return (out || '/').slice(0, 200);
}

/**
 * The build's sample rate, 0…1. `NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE` is inlined
 * at build time; unset, empty or unparseable is 0 — the reporter never runs.
 */
export function webVitalsSampleRate(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}
